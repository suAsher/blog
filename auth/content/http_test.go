package content

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func apiCall(handler http.Handler, method, path string, value any) *httptest.ResponseRecorder {
	data, _ := json.Marshal(value)
	r := httptest.NewRequest(method, path, strings.NewReader(string(data)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
func apiDetail(t *testing.T, w *httptest.ResponseRecorder) Detail {
	t.Helper()
	var envelope struct {
		OK   bool   `json:"ok"`
		Data Detail `json:"data"`
	}
	if json.Unmarshal(w.Body.Bytes(), &envelope) != nil || !envelope.OK {
		t.Fatalf("detail error %d: %s", w.Code, w.Body.String())
	}
	return envelope.Data
}

func TestHTTPLifecycleAndErrorContracts(t *testing.T) {
	s := testStore(t)
	handler := NewHandler(s)
	w := apiCall(handler, "POST", "/api/documents", input("## 已发布正文"))
	if w.Code != 201 {
		t.Fatal(w.Code)
	}
	d := apiDetail(t, w)
	w = apiCall(handler, "POST", "/api/documents/"+d.ID+"/publish", map[string]int{"version": d.Version})
	d = apiDetail(t, w)
	update := map[string]any{"title": "修改中的标题", "description": "摘要", "date": "2026-10-25", "tags": []string{"新标签"}, "category": "新分类", "cover": "", "source": "未发布修改", "version": d.Version}
	w = apiCall(handler, "PUT", "/api/documents/"+d.ID, update)
	d = apiDetail(t, w)
	w = apiCall(handler, "GET", "/api/documents/"+d.ID+"?view=published", nil)
	live := apiDetail(t, w)
	if live.Title != "真实文档" || strings.Contains(live.Source, "未发布") {
		t.Fatal("live detail did not use published snapshot")
	}
	if apiCall(handler, "PUT", "/api/documents/"+d.ID, update).Code != 409 {
		t.Fatal("HTTP conflict missing")
	}
	w = apiCall(handler, "POST", "/api/documents/"+d.ID+"/unpublish", map[string]int{"version": d.Version})
	d = apiDetail(t, w)
	if apiCall(handler, "GET", "/api/documents/"+d.ID+"?view=published", nil).Code != 404 {
		t.Fatal("withdrawn document still visible")
	}
	w = apiCall(handler, "POST", "/api/documents/"+d.ID+"/trash", map[string]int{"version": d.Version})
	d = apiDetail(t, w)
	if apiCall(handler, "DELETE", "/api/documents/"+d.ID, map[string]int{"version": d.Version}).Code != 200 {
		t.Fatal("delete HTTP")
	}
	if apiCall(handler, "GET", "/api/documents/"+d.ID, nil).Code != 404 {
		t.Fatal("deleted HTTP detail")
	}
	for _, target := range []string{"/api/documents?limit=no", "/api/documents?offset=-1", "/api/documents?limit=1001", "/api/documents?status=secret"} {
		if apiCall(handler, "GET", target, nil).Code != 400 {
			t.Fatal("invalid list arguments accepted")
		}
	}
	for _, target := range []string{"/api/unknown", "/api/documents/" + d.ID + "/unknown/extra", "/api/assets/../../secret"} {
		if apiCall(handler, "GET", target, nil).Code != 404 {
			t.Fatal("unknown path did not return404")
		}
	}
	if apiCall(handler, "GET", "/api/preview", nil).Code != 405 {
		t.Fatal("preview GET")
	}
	if apiCall(handler, "PUT", "/api/documents/"+d.ID+"/publish", nil).Code != 405 {
		t.Fatal("mutation bad method")
	}
	if apiCall(handler, "POST", "/api/assets/not-an-asset", nil).Code != 405 {
		t.Fatal("asset bad method")
	}
	if apiCall(handler, "GET", "/api/import", nil).Code != 405 {
		t.Fatal("import bad method")
	}
	if apiCall(handler, "GET", "/api/assets", nil).Code != 405 {
		t.Fatal("asset collection bad method")
	}
	r := httptest.NewRequest("POST", "/api/documents", strings.NewReader(`{}`))
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("JSON media type required")
	}
	for _, data := range []string{`{`, `{"title":"x","source":"s","extra":true}`, `{"title":"x"} {}`} {
		r := httptest.NewRequest("POST", "/api/documents", strings.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatal("malformed input accepted")
		}
	}
}

func TestMetadataValidationAndSearchBoundaries(t *testing.T) {
	s := testStore(t)
	base := input("source")
	invalid := []Content{}
	c := base
	c.Title = ""
	invalid = append(invalid, c)
	c = base
	c.Title = "bad\nheading"
	invalid = append(invalid, c)
	c = base
	c.Description = strings.Repeat("a", 501)
	invalid = append(invalid, c)
	c = base
	c.Category = strings.Repeat("a", 101)
	invalid = append(invalid, c)
	c = base
	c.Date = "yesterday"
	invalid = append(invalid, c)
	c = base
	c.Tags = make([]string, 21)
	invalid = append(invalid, c)
	c = base
	c.Tags = []string{strings.Repeat("x", 65)}
	invalid = append(invalid, c)
	c = base
	c.Cover = "https://remote.invalid/img.png"
	invalid = append(invalid, c)
	c = base
	c.Source = "binary\x00"
	invalid = append(invalid, c)
	c = base
	c.Source = "binary\x01"
	invalid = append(invalid, c)
	c = base
	c.Source = string([]byte{0xff})
	invalid = append(invalid, c)
	for _, value := range invalid {
		if _, err := s.Create(value, "", nil); err == nil {
			t.Fatal("invalid content accepted")
		}
	}
	c = base
	c.Description = ""
	c.Date = ""
	c.Tags = []string{" 重复 ", "重复", ""}
	c.Cover = "/images/notes.svg"
	d := mustCreate(t, s, c)
	if len(d.Tags) != 1 || d.Description != "source" || len(d.Date) != 10 {
		t.Fatal("normalization failed")
	}
	if _, err := s.Action(d.ID, "restore", d.Version); err == nil {
		t.Fatal("restore nontrash accepted")
	}
	if _, err := s.Action(d.ID, "unpublish", d.Version); err == nil {
		t.Fatal("unpublish draft accepted")
	}
	if _, err := s.Action(d.ID, "publish", d.Version+1); err == nil {
		t.Fatal("stale action accepted")
	}
	if _, err := s.Action(d.ID, "unknown", d.Version); err == nil {
		t.Fatal("unknown action accepted")
	}
	d, _ = s.Action(d.ID, "trash", d.Version)
	if _, err := s.Update(d.ID, base, d.Version); err == nil {
		t.Fatal("editing trash accepted")
	}
	if _, err := s.Action(d.ID, "trash", d.Version); err == nil {
		t.Fatal("trash repeated")
	}
	if err := s.Delete(d.ID, d.Version+1); err == nil {
		t.Fatal("stale permanent delete")
	}
	c = base
	c.Source = ""
	empty := mustCreate(t, s, c)
	if _, err := s.Action(empty.ID, "publish", empty.Version); err == nil {
		t.Fatal("empty publication")
	}
	c = base
	c.Source = "ＵｎｉｑｕｅCodeToken 特殊内容"
	d = mustCreate(t, s, c)
	d, _ = s.Action(d.ID, "publish", d.Version)
	result, err := s.List(ListOptions{Query: "UniqueCodeToken", Category: "测试分类", Limit: 20})
	if err != nil || result.Total != 1 {
		t.Fatal("wide-character search/category filter")
	}
	result, _ = s.List(ListOptions{Category: "not present", Limit: 20})
	if result.Total != 0 {
		t.Fatal("missing category")
	}
	result, _ = s.List(ListOptions{Offset: 10000, Limit: 10})
	if len(result.Documents) != 0 {
		t.Fatal("out-of-range pagination")
	}
	if _, err := s.List(ListOptions{Query: strings.Repeat("x", 257)}); err == nil {
		t.Fatal("query too long")
	}
}

func TestConcurrentSaveHasOneWinner(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("original"))
	errors := make(chan error, 2)
	var group sync.WaitGroup
	for _, source := range []string{"writer one", "writer two"} {
		group.Add(1)
		go func(source string) {
			defer group.Done()
			_, err := s.Update(d.ID, input(source), d.Version)
			errors <- err
		}(source)
	}
	group.Wait()
	close(errors)
	wins := 0
	conflicts := 0
	for err := range errors {
		if err == nil {
			wins++
		} else if known, ok := err.(*apiError); ok && known.Status == 409 {
			conflicts++
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal("concurrent editors lost a write without conflict")
	}
}

func TestCorruptedStorageAndSymlinkAreNeverFollowed(t *testing.T) {
	s := testStore(t)
	id := strings.Repeat("a", 32)
	name := filepath.Join(s.root, "documents", id+".json")
	if err := os.WriteFile(name, []byte(`{"broken":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(id, ""); err == nil {
		t.Fatal("corrupt record accepted")
	}
	if _, err := s.List(ListOptions{}); err == nil {
		t.Fatal("corrupt record hidden silently")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(outside, []byte("private"), 0600)
	if err := os.Symlink(outside, name); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(id, ""); err == nil {
		t.Fatal("document symlink was followed")
	}
}
