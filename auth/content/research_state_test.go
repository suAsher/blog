package content

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func researchHandler(s *Store) http.Handler {
	h := &handler{store: s}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/annotations") {
			h.annotations(w, r, r.URL.Path)
		} else {
			h.workspaces(w, r, r.URL.Path)
		}
	})
}
func researchData(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code >= 400 {
		t.Fatalf("request %d: %s", w.Code, w.Body.String())
	}
	return metadataResult(t, w)
}
func publishedResearchDoc(t *testing.T, s *Store) Detail {
	t.Helper()
	d := mustCreate(t, s, input("## Heading\n\nPublished quote."))
	p, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func annotationInput(id string) map[string]any {
	return map[string]any{"documentId": id, "quote": map[string]string{"exact": "Published quote.", "prefix": "", "suffix": ""}, "body": "<script>untrusted</script>"}
}
func workspaceInput(ids ...string) map[string]any {
	if ids == nil {
		ids = []string{}
	}
	return map[string]any{"title": "Topic", "description": "Study", "documentIds": ids, "questions": []any{map[string]any{"id": "question_1", "text": "Why?", "done": false}}}
}

func TestResearchAnnotationsDurableCASAndVisibility(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	empty := researchData(t, apiCall(h, "GET", "/api/annotations?documentId="+d.ID, nil))
	if len(empty["annotations"].([]any)) != 0 {
		t.Fatal(empty)
	}
	w := apiCall(h, "POST", "/api/annotations", annotationInput(d.ID))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	a := researchData(t, w)
	id := a["id"].(string)
	if a["color"] != "mint" || a["version"] != float64(1) || a["body"] != "<script>untrusted</script>" {
		t.Fatal(a)
	}
	changed := researchData(t, apiCall(h, "PUT", "/api/annotations/"+id, map[string]any{"version": 1, "body": "revised", "color": "violet"}))
	if changed["version"] != float64(2) {
		t.Fatal(changed)
	}
	if w = apiCall(h, "DELETE", "/api/annotations/"+id, map[string]int{"version": 1}); w.Code != 409 {
		t.Fatal(w.Code)
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	persisted := researchData(t, apiCall(researchHandler(reopened), "GET", "/api/annotations?documentId="+d.ID, nil))
	if len(persisted["annotations"].([]any)) != 1 {
		t.Fatal(persisted)
	}
	info, err := os.Stat(filepath.Join(s.root, "state", "research.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("unsafe state", err)
	}
	if _, err = s.Action(d.ID, "unpublish", d.Version); err != nil {
		t.Fatal(err)
	}
	for _, call := range []struct {
		method, path string
		body         any
	}{{"GET", "/api/annotations?documentId=" + d.ID, nil}, {"POST", "/api/annotations", annotationInput(d.ID)}, {"PUT", "/api/annotations/" + id, map[string]any{"version": 2, "body": "hidden"}}} {
		if w = apiCall(h, call.method, call.path, call.body); w.Code != 404 {
			t.Fatal("unpublished annotation exposed", w.Code, w.Body.String())
		}
	}
}

func TestResearchWorkspacesPreserveOrderDraftRefsAndStaleRefs(t *testing.T) {
	s := testStore(t)
	draft := mustCreate(t, s, input("Draft private"))
	pub := publishedResearchDoc(t, s)
	h := researchHandler(s)
	if len(researchData(t, apiCall(h, "GET", "/api/workspaces", nil))["workspaces"].([]any)) != 0 {
		t.Fatal("not empty")
	}
	in := workspaceInput(draft.ID, pub.ID)
	in["positions"] = []any{map[string]any{"id": draft.ID, "x": 12.5, "y": -10}}
	w := apiCall(h, "POST", "/api/workspaces", in)
	if w.Code != 201 {
		t.Fatal(w.Body.String())
	}
	created := researchData(t, w)
	id := created["id"].(string)
	if created["documentIds"].([]any)[0] != draft.ID {
		t.Fatal("order lost")
	}
	in["version"] = 1
	in["title"] = "New topic"
	updated := researchData(t, apiCall(h, "PUT", "/api/workspaces/"+id, in))
	if updated["version"] != float64(2) {
		t.Fatal(updated)
	}
	if w = apiCall(h, "PUT", "/api/workspaces/"+id, in); w.Code != 409 {
		t.Fatal("stale update accepted", w.Code)
	}
	if _, err := s.Action(draft.ID, "trash", draft.Version); err != nil {
		t.Fatal(err)
	}
	stale := researchData(t, apiCall(h, "GET", "/api/workspaces/"+id, nil))
	if len(stale["documentIds"].([]any)) != 2 {
		t.Fatal("stale reference silently removed")
	}
	in["version"] = 2
	if w = apiCall(h, "PUT", "/api/workspaces/"+id, in); w.Code != 200 {
		t.Fatal("retained stale ref blocked unrelated edit", w.Code, w.Body.String())
	}
	if w = apiCall(h, "DELETE", "/api/workspaces/"+id, map[string]int{"version": 3}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w = apiCall(h, "GET", "/api/workspaces/"+id, nil); w.Code != 404 {
		t.Fatal("deleted remains")
	}
}

func TestResearchWorkspaceRetainsMissingRefsButRejectsNewMissingRefs(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("Private draft"))
	h := researchHandler(s)
	in := workspaceInput(d.ID)
	created := researchData(t, apiCall(h, "POST", "/api/workspaces", in))
	id := created["id"].(string)
	if err := os.Remove(filepath.Join(s.root, "documents", d.ID+".json")); err != nil {
		t.Fatal(err)
	}
	in["version"] = 1
	in["title"] = "Edited despite unavailable source"
	retained := researchData(t, apiCall(h, "PUT", "/api/workspaces/"+id, in))
	if retained["version"] != float64(2) || retained["documentIds"].([]any)[0] != d.ID {
		t.Fatal("missing ref not retained", retained)
	}
	in["version"] = 2
	in["documentIds"] = []string{d.ID, strings.Repeat("f", 32)}
	if w := apiCall(h, "PUT", "/api/workspaces/"+id, in); w.Code != 404 {
		t.Fatal("new missing ref accepted", w.Code, w.Body.String())
	}
	if w := apiCall(h, "POST", "/api/workspaces", workspaceInput(d.ID)); w.Code != 404 {
		t.Fatal("new workspace missing ref accepted", w.Code)
	}
}

func TestResearchStrictRequestsAndAtomicDiskFailure(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	invalid := annotationInput(d.ID)
	invalid["color"] = "red"
	if w := apiCall(h, "POST", "/api/annotations", invalid); w.Code != 400 {
		t.Fatal(w.Code)
	}
	invalid = annotationInput(d.ID)
	invalid["body"] = strings.Repeat("x", 8001)
	if w := apiCall(h, "POST", "/api/annotations", invalid); w.Code != 400 {
		t.Fatal(w.Code)
	}
	for _, in := range []map[string]any{{"title": "x"}, workspaceInput(d.ID, d.ID), workspaceInput(strings.Repeat("a", 32))} {
		if w := apiCall(h, "POST", "/api/workspaces", in); w.Code < 400 {
			t.Fatal("invalid workspace", w.Body.String())
		}
	}
	r := httptest.NewRequest("POST", "/api/annotations", strings.NewReader(strings.Repeat(" ", 65537)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 {
		t.Fatal("request unbounded", w.Code)
	}
	s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
	if w = apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)); w.Code != 507 {
		t.Fatal(w.Code)
	}
	if len(researchData(t, apiCall(h, "GET", "/api/annotations?documentId="+d.ID, nil))["annotations"].([]any)) != 0 {
		t.Fatal("failed save visible")
	}
}

func TestResearchUnsafeStateFailsClosed(t *testing.T) {
	for _, kind := range []string{"symlink", "public", "corrupt", "future", "oversize"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			name := filepath.Join(s.root, "state", "research.json")
			data := []byte(`{"schemaVersion":99,"annotations":{},"workspaces":{}}`)
			switch kind {
			case "symlink":
				outside := filepath.Join(t.TempDir(), "outside")
				_ = os.WriteFile(outside, []byte(`{}`), 0600)
				_ = os.Symlink(outside, name)
			case "public":
				_ = os.WriteFile(name, data, 0644)
			case "corrupt":
				_ = os.WriteFile(name, []byte(`{"schemaVersion":1}`), 0600)
			case "oversize":
				f, _ := os.Create(name)
				_ = f.Truncate(16<<20 + 1)
				_ = f.Chmod(0600)
				_ = f.Close()
			default:
				_ = os.WriteFile(name, data, 0600)
			}
			if w := apiCall(researchHandler(s), "GET", "/api/workspaces", nil); w.Code != 500 {
				t.Fatal("unsafe state accepted", w.Code, w.Body.String())
			}
		})
	}
}

func TestResearchConcurrentCASHasOneWinner(t *testing.T) {
	s := testStore(t)
	h := researchHandler(s)
	created := researchData(t, apiCall(h, "POST", "/api/workspaces", workspaceInput()))
	id := created["id"].(string)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			in := workspaceInput()
			in["version"] = 1
			codes <- apiCall(h, "PUT", "/api/workspaces/"+id, in).Code
		}()
	}
	wg.Wait()
	close(codes)
	seen := map[int]int{}
	for c := range codes {
		seen[c]++
	}
	if seen[200] != 1 || seen[409] != 1 {
		t.Fatal(seen)
	}
}

func TestResearchUnknownJSONAndRevisionRejected(t *testing.T) {
	s := testStore(t)
	h := researchHandler(s)
	d := publishedResearchDoc(t, s)
	for _, body := range []string{`null`, `{"documentId":"` + d.ID + `","quote":{"exact":"x"},"body":"","unknown":true}`, `{"documentId":"` + d.ID + `","quote":{"exact":"x"},"body":""} {}`} {
		r := httptest.NewRequest("POST", "/api/annotations", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestResearchRejectsSemanticDuplicateJSONFields(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	body := `{"documentId":"` + d.ID + `","quote":{"exact":"quote","prefix":"","suffix":""},"body":"first","BODY":"second"}`
	r := httptest.NewRequest("POST", "/api/annotations", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	researchHandler(s).ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("semantic duplicate field accepted", w.Code, w.Body.String())
	}
}

func TestResearchRejectsMissingStoredFields(t *testing.T) {
	for _, field := range []string{"annotation-body", "question-done"} {
		t.Run(field, func(t *testing.T) {
			s := testStore(t)
			d := publishedResearchDoc(t, s)
			h := researchHandler(s)
			a := researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
			w := researchData(t, apiCall(h, "POST", "/api/workspaces", workspaceInput()))
			name := filepath.Join(s.root, "state", "research.json")
			data, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			var raw map[string]any
			if json.Unmarshal(data, &raw) != nil {
				t.Fatal("invalid fixture")
			}
			if field == "annotation-body" {
				delete(raw["annotations"].(map[string]any)[a["id"].(string)].(map[string]any), "body")
			} else {
				delete(raw["workspaces"].(map[string]any)[w["id"].(string)].(map[string]any)["questions"].([]any)[0].(map[string]any), "done")
			}
			data, _ = json.Marshal(raw)
			if err = os.WriteFile(name, data, 0600); err != nil {
				t.Fatal(err)
			}
			if got := apiCall(h, "GET", "/api/workspaces", nil); got.Code != 500 {
				t.Fatal("missing stored field accepted", got.Code, got.Body.String())
			}
		})
	}
}

func TestResearchListsSortFractionalTimestampsChronologically(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	base := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base.Add(100 * time.Millisecond) }
	a := researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
	researchData(t, apiCall(h, "POST", "/api/workspaces", workspaceInput()))
	s.now = func() time.Time { return base.Add(120 * time.Millisecond) }
	researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
	latest := researchData(t, apiCall(h, "POST", "/api/workspaces", workspaceInput()))
	annotations := researchData(t, apiCall(h, "GET", "/api/annotations?documentId="+d.ID, nil))["annotations"].([]any)
	if annotations[0].(map[string]any)["id"] != a["id"] {
		t.Fatal("annotations not chronological")
	}
	workspaces := researchData(t, apiCall(h, "GET", "/api/workspaces", nil))["workspaces"].([]any)
	if workspaces[0].(map[string]any)["id"] != latest["id"] {
		t.Fatal("workspaces not recent first")
	}
}

func TestResearchRouteMethodsAndValidationBoundaries(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	for _, call := range []struct {
		method, path string
		value        any
		status       int
	}{
		{"PATCH", "/api/annotations", nil, 405}, {"GET", "/api/annotations", nil, 400}, {"GET", "/api/annotations?documentId=" + d.ID + "&documentId=" + d.ID, nil, 400},
		{"GET", "/api/annotations/not-an-id", nil, 404}, {"GET", "/api/annotations/" + d.ID, nil, 405}, {"PUT", "/api/annotations/" + d.ID, map[string]any{"version": 1, "body": "missing"}, 404},
		{"DELETE", "/api/annotations/" + d.ID, map[string]any{"version": 0}, 400}, {"PUT", "/api/annotations/" + d.ID, map[string]any{"version": 1, "body": "ok", "color": "red"}, 400},
		{"PATCH", "/api/workspaces", nil, 405}, {"GET", "/api/workspaces/not-an-id", nil, 404}, {"PATCH", "/api/workspaces/" + d.ID, nil, 405},
		{"PUT", "/api/workspaces/" + d.ID, workspaceInput(), 400}, {"DELETE", "/api/workspaces/" + d.ID, map[string]int{"version": 0}, 400}, {"DELETE", "/api/workspaces/" + d.ID, map[string]int{"version": 1}, 404},
	} {
		if w := apiCall(h, call.method, call.path, call.value); w.Code != call.status {
			t.Fatalf("%s %s: got %d expected %d: %s", call.method, call.path, w.Code, call.status, w.Body.String())
		}
	}
	in := workspaceInput(d.ID)
	in["positions"] = []any{map[string]any{"id": d.ID, "x": 100001, "y": 0}}
	if w := apiCall(h, "POST", "/api/workspaces", in); w.Code != 400 {
		t.Fatal("unbounded position", w.Body.String())
	}
	in = workspaceInput()
	in["questions"] = []any{map[string]any{"id": "bad/id", "text": "valid", "done": true}}
	if w := apiCall(h, "POST", "/api/workspaces", in); w.Code != 400 {
		t.Fatal("invalid question", w.Code)
	}
	in = workspaceInput()
	in["version"] = 1
	if w := apiCall(h, "POST", "/api/workspaces", in); w.Code != 400 {
		t.Fatal("version on create", w.Code)
	}
	for _, body := range []string{`{"body":"a","body":"b"}`, `{"body":null}`, `{"body":`, strings.Repeat(`{"a":`, 18) + `1` + strings.Repeat(`}`, 18)} {
		r := httptest.NewRequest("POST", "/api/annotations", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/api/workspaces", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal(w.Code)
	}
	created := researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
	id := created["id"].(string)
	if w := apiCall(h, "DELETE", "/api/annotations/"+id, map[string]int{"version": 1}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := apiCall(h, "DELETE", "/api/annotations/"+id, map[string]int{"version": 1}); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

func TestResearchQuotaAndRevisionExhaustion(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	stamp := s.now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	state := newResearchFile()
	for n := 0; n < maxDocumentAnnotations; n++ {
		id := fmt.Sprintf("%032x", n+1)
		state.Annotations[id] = Annotation{ID: id, DocumentID: d.ID, Quote: TextQuote{Exact: "text"}, Body: "", Color: "mint", Version: 1, CreatedAt: stamp, UpdatedAt: stamp}
	}
	if err := s.saveResearchLocked(state); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)); w.Code != 413 {
		t.Fatal("perdoc quota", w.Code)
	}
	id := fmt.Sprintf("%032x", 1)
	a := state.Annotations[id]
	a.Version = maxSafeRevision
	state.Annotations[id] = a
	if err := s.saveResearchLocked(state); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "PUT", "/api/annotations/"+id, map[string]any{"version": maxSafeRevision, "body": "overflow"}); w.Code != 409 {
		t.Fatal("unsafe revision", w.Code)
	}
	for n := 0; n < maxWorkspaces; n++ {
		id := fmt.Sprintf("%032x", n+1)
		state.Workspaces[id] = Workspace{ID: id, Title: "Topic", DocumentIDs: []string{}, Questions: []WorkspaceQuestion{}, Positions: []WorkspacePosition{}, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}
	}
	first := state.Workspaces[id]
	first.Version = maxSafeRevision
	state.Workspaces[id] = first
	if err := s.saveResearchLocked(state); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "POST", "/api/workspaces", workspaceInput()); w.Code != 413 {
		t.Fatal("workspace quota", w.Code, w.Body.String())
	}
	in := workspaceInput()
	in["version"] = maxSafeRevision
	if w := apiCall(h, "PUT", "/api/workspaces/"+id, in); w.Code != 409 {
		t.Fatal("workspace overflow", w.Code, w.Body.String())
	}
	if w := apiCall(h, "DELETE", "/api/workspaces/"+id, map[string]int{"version": 1}); w.Code != 409 {
		t.Fatal("stale delete", w.Code)
	}
	all := researchData(t, apiCall(h, "GET", "/api/workspaces", nil))["workspaces"].([]any)
	if len(all) != maxWorkspaces {
		t.Fatal("list lost workspace")
	}
}

func TestResearchCorruptRecordsAndUnsafeDirectories(t *testing.T) {
	for _, kind := range []string{"state-directory", "document-directory", "document-symlink", "document-corrupt", "document-missing"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			d := publishedResearchDoc(t, s)
			name := filepath.Join(s.root, "documents", d.ID+".json")
			switch kind {
			case "state-directory":
				if err := os.Chmod(filepath.Join(s.root, "state"), 0755); err != nil {
					t.Fatal(err)
				}
			case "document-directory":
				original := filepath.Join(s.root, "documents")
				moved := filepath.Join(s.root, "documents-original")
				_ = os.Rename(original, moved)
				_ = os.Symlink(moved, original)
			case "document-symlink":
				outside := filepath.Join(t.TempDir(), "outside")
				_ = os.WriteFile(outside, []byte(`{}`), 0600)
				_ = os.Remove(name)
				_ = os.Symlink(outside, name)
			case "document-corrupt":
				_ = os.WriteFile(name, []byte(`{}`), 0600)
			case "document-missing":
				_ = os.Remove(name)
			}
			w := apiCall(researchHandler(s), "GET", "/api/annotations?documentId="+d.ID, nil)
			want := 500
			if kind == "document-missing" {
				want = 404
			}
			if w.Code != want {
				t.Fatal(w.Code, w.Body.String())
			}
		})
	}
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	a := researchData(t, apiCall(researchHandler(s), "POST", "/api/annotations", annotationInput(d.ID)))
	state, err := s.loadResearchLocked()
	if err != nil {
		t.Fatal(err)
	}
	value := state.Annotations[a["id"].(string)]
	value.CreatedAt = "invalid"
	state.Annotations[value.ID] = value
	if err := s.saveResearchLocked(state); err == nil {
		t.Fatal("corrupt timestamp persisted")
	}
}
