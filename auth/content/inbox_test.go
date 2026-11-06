package content

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func inboxTestHandler(s *Store) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		(&handler{store: s}).inbox(w, r, r.URL.Path)
	})
}

func inboxResult(t *testing.T, h http.Handler, query string) inboxData {
	t.Helper()
	w := apiCall(h, "GET", "/api/inbox"+query, nil)
	var envelope struct {
		OK   bool      `json:"ok"`
		Data inboxData `json:"data"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || !envelope.OK {
		t.Fatalf("inbox read: %d %s", w.Code, w.Body.String())
	}
	return envelope.Data
}

func inboxBatch(version int64, stage string, ids ...string) map[string]any {
	return map[string]any{"version": version, "stage": stage, "documentIds": ids}
}

func TestInboxLifecyclePreservesDocuments(t *testing.T) {
	s := testStore(t)
	h := inboxTestHandler(s)
	d := mustCreate(t, s, input("private-source-needle"))
	before, err := os.ReadFile(filepath.Join(s.root, "documents", d.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	empty := inboxResult(t, h, "")
	if empty.Version != 0 || empty.Total != 1 || empty.Documents[0].Stage != "pending" || empty.Counts.Pending != 1 {
		t.Fatal(empty)
	}
	if _, err := os.Stat(filepath.Join(s.root, "state", "inbox.json")); !os.IsNotExist(err) {
		t.Fatal("reading defaults must not create state")
	}
	for i, stage := range []string{"organized", "verified", "pending"} {
		w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(int64(i), stage, d.ID))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		state := inboxResult(t, h, "?view=all")
		if state.Version != int64(i+1) || state.Documents[0].Stage != stage {
			t.Fatal(state)
		}
		if stage == "verified" {
			verified := inboxResult(t, h, "?view=verified")
			if verified.Total != 1 {
				t.Fatal("verified documents need their own view", verified)
			}
		}
	}
	after, _ := os.ReadFile(filepath.Join(s.root, "documents", d.ID+".json"))
	if !reflect.DeepEqual(before, after) {
		t.Fatal("triage changed original document bytes")
	}
	if result, err := s.List(ListOptions{Status: "published"}); err != nil || result.Total != 0 {
		t.Fatal("triage published a draft")
	}
	info, err := os.Stat(filepath.Join(s.root, "state", "inbox.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe state permissions", err)
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if state := inboxResult(t, inboxTestHandler(reopened), "?view=all"); state.Version != 3 {
		t.Fatal(state)
	}
}

func TestInboxMetadataFiltersAndRoutes(t *testing.T) {
	s := testStore(t)
	h := inboxTestHandler(s)
	first := input("only-body-needle")
	first.Title, first.Tags, first.Series = "Ｇｏ 数据流", []string{"管线"}, "工程笔记"
	a := mustCreate(t, s, first)
	b := mustCreate(t, s, input("another private body"))
	c := mustCreate(t, s, input("trash body"))
	if _, err := s.Action(c.ID, "trash", c.Version); err != nil {
		t.Fatal(err)
	}
	route := researchData(t, apiCall(NewHandler(s), "POST", "/api/learning-paths", learningInput(a.ID)))
	routeID := route["id"].(string)
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(0, "organized", a.ID)); w.Code != 200 {
		t.Fatal(w.Code)
	}
	queries := map[string]int{
		"?view=all": 2, "?view=pending": 1, "?view=unverified": 1, "?view=unassigned": 1,
		"?view=all&q=go": 1, "?view=all&q=only-body-needle": 0,
		"?view=all&q=" + url.QueryEscape("工程笔记"):       1,
		"?view=all&tag=" + url.QueryEscape("管线"):       1,
		"?view=all&routeId=" + routeID:                 1,
		"?view=all&routeId=" + strings.Repeat("a", 32): 0,
	}
	for query, want := range queries {
		data := inboxResult(t, h, query)
		if data.Total != want {
			t.Fatalf("%s: %d want %d", query, data.Total, want)
		}
		if data.Counts.All != 2 || data.Counts.Unassigned != 1 || data.Counts.Unverified != 1 {
			t.Fatal(data.Counts)
		}
		for _, item := range data.Documents {
			if item.Body != "" {
				t.Fatal("response exposed body")
			}
		}
	}
	if got := inboxResult(t, h, "?view=all&limit=1&offset=1"); len(got.Documents) != 1 || got.Total != 2 {
		t.Fatal(got)
	}
	if got := inboxResult(t, h, "?view=all&offset=99"); len(got.Documents) != 0 {
		t.Fatal(got)
	}
	if got := inboxResult(t, h, "?view=unassigned"); got.Documents[0].ID != b.ID {
		t.Fatal(got)
	}
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(1, "verified", b.ID, c.ID)); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if got := inboxResult(t, h, "?view=pending"); got.Total != 1 || got.Version != 1 {
		t.Fatal("batch partially committed", got)
	}
}

func TestInboxSavedViewsAndCAS(t *testing.T) {
	s := testStore(t)
	h := inboxTestHandler(s)
	d := mustCreate(t, s, input("source"))
	views := []any{map[string]any{"id": "my-route", "name": "稍后整理", "filter": map[string]any{"view": "unassigned", "q": "", "tag": "", "routeId": strings.Repeat("a", 32)}}}
	if w := apiCall(h, "PUT", "/api/inbox/views", map[string]any{"version": 0, "views": views}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := inboxResult(t, h, ""); len(got.Views) != 1 || got.Views[0].Filter.RouteID != strings.Repeat("a", 32) {
		t.Fatal(got)
	}
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(1, "verified", d.ID)).Code
		}()
	}
	wg.Wait()
	close(codes)
	wins := 0
	for code := range codes {
		if code == 200 {
			wins++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if wins != 1 {
		t.Fatal(wins)
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", map[string]any{"version": 1, "views": []any{}}); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", map[string]any{"version": 2, "views": []any{}}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if got := inboxResult(t, h, ""); len(got.Views) != 0 {
		t.Fatal(got)
	}
}

func TestInboxValidationAndUnsafeState(t *testing.T) {
	s := testStore(t)
	h := inboxTestHandler(s)
	d := mustCreate(t, s, input("source"))
	for _, query := range []string{"?view=bad", "?limit=0", "?limit=101", "?limit=no", "?offset=-1", "?offset=no", "?routeId=../x", "?q=" + strings.Repeat("x", 257), "?tag=" + strings.Repeat("x", 81), "?view=all&view=pending", "?unknown=x"} {
		if w := apiCall(h, "GET", "/api/inbox"+query, nil); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
	for _, body := range []any{inboxBatch(-1, "pending", d.ID), inboxBatch(0, "invalid", d.ID), inboxBatch(0, "pending", d.ID, d.ID), inboxBatch(0, "pending", "invalid"), inboxBatch(0, "pending"), map[string]any{"stage": "pending", "documentIds": []string{d.ID}}, map[string]any{"version": 0, "stage": "pending", "documentIds": []string{d.ID}, "extra": true}} {
		if w := apiCall(h, "PUT", "/api/inbox/batch", body); w.Code != 400 {
			t.Fatal(body, w.Code)
		}
	}
	for _, body := range []string{`{"version":0,"version":1,"stage":"pending","documentIds":[]}`, `{"version":0,"views":null}`, `{"version":0,"views":[]}` + strings.Repeat(" ", 32<<10)} {
		r := httptest.NewRequest("PUT", "/api/inbox/views", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 && w.Code != 413 {
			t.Fatal(w.Code)
		}
	}
	for _, name := range []string{"inbox.json", "learning.json"} {
		t.Run(name, func(t *testing.T) {
			s := testStore(t)
			os.WriteFile(filepath.Join(s.root, "state", name), []byte("{}"), 0600)
			if w := apiCall(inboxTestHandler(s), "GET", "/api/inbox", nil); w.Code != 500 {
				t.Fatal(w.Code)
			}
		})
	}
	unsafe := filepath.Join(t.TempDir(), "outside")
	os.WriteFile(unsafe, []byte("unchanged"), 0600)
	os.Symlink(unsafe, filepath.Join(s.root, "state", "inbox.json"))
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(0, "verified", d.ID)); w.Code != 500 {
		t.Fatal(w.Code)
	}
	data, _ := os.ReadFile(unsafe)
	if string(data) != "unchanged" {
		t.Fatal("unsafe write")
	}
}
