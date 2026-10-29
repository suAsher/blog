package content

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func learningInput(ids ...string) map[string]any {
	if ids == nil {
		ids = []string{}
	}
	return map[string]any{"title": "Go 入门", "description": "从零开始", "accent": "mint", "chapters": []any{map[string]any{"id": "start", "title": "第一章", "description": "", "documentIds": ids}}}
}
func TestLearningLifecycle(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	d := mustCreate(t, s, input("private source"))
	empty := researchData(t, apiCall(h, "GET", "/api/learning-paths", nil))
	if len(empty["paths"].([]any)) != 0 {
		t.Fatal(empty)
	}
	a := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningInput(d.ID)))
	id := a["id"].(string)
	b, _ := json.Marshal(a)
	if strings.Contains(string(b), "private source") {
		t.Fatal("exposed source")
	}
	reopened, e := NewStore(s.root)
	if e != nil {
		t.Fatal(e)
	}
	researchData(t, apiCall(NewHandler(reopened), "GET", "/api/learning-paths/"+id, nil))
	info, e := os.Stat(filepath.Join(s.root, "state", "learning.json"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal(e)
	}
	v := learningInput(d.ID)
	v["version"] = 1
	researchData(t, apiCall(h, "PUT", "/api/learning-paths/"+id, v))
	if w := apiCall(h, "PUT", "/api/learning-paths/"+id, v); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if _, e = s.Action(d.ID, "trash", d.Version); e != nil {
		t.Fatal(e)
	}
	v["version"] = 2
	researchData(t, apiCall(h, "PUT", "/api/learning-paths/"+id, v))
	if w := apiCall(h, "POST", "/api/learning-paths", learningInput(d.ID)); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if w := apiCall(h, "DELETE", "/api/learning-paths/"+id, map[string]int{"version": 2}); w.Code != 409 {
		t.Fatal(w.Code)
	}
	researchData(t, apiCall(h, "DELETE", "/api/learning-paths/"+id, map[string]int{"version": 3}))
	if w := apiCall(h, "GET", "/api/learning-paths/"+id, nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
func TestLearningValidationBudget(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	for _, key := range []string{"title", "description", "accent", "chapters"} {
		v := learningInput()
		delete(v, key)
		if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 400 {
			t.Fatal(key, w.Code)
		}
	}
	for _, body := range []string{`{"title":"a","title":"b"}`, `{"title":null}`, `{` + strings.Repeat(" ", 128<<10) + `}`} {
		r := httptest.NewRequest("POST", "/api/learning-paths", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 && w.Code != 413 {
			t.Fatal(w.Code)
		}
	}
	for i := 0; i < 50; i++ {
		researchData(t, apiCall(h, "POST", "/api/learning-paths", learningInput()))
	}
	listed := researchData(t, apiCall(h, "GET", "/api/learning-paths", nil))
	if len(listed["paths"].([]any)) != 50 {
		t.Fatal(listed)
	}
	if w := apiCall(h, "POST", "/api/learning-paths", learningInput()); w.Code != 413 {
		t.Fatal(w.Code)
	}
}
func TestLearningUnsafeStorage(t *testing.T) {
	for _, body := range []string{`{}`, `{"schemaVersion":2,"paths":{}}`, strings.Repeat(" ", (8<<20)+1)} {
		s := testStore(t)
		os.WriteFile(filepath.Join(s.root, "state", "learning.json"), []byte(body), 0600)
		if w := apiCall(NewHandler(s), "POST", "/api/learning-paths", learningInput()); w.Code != 500 {
			t.Fatal(w.Code)
		}
	}
	s := testStore(t)
	external := filepath.Join(t.TempDir(), "external")
	os.WriteFile(external, []byte("untouched"), 0600)
	os.Symlink(external, filepath.Join(s.root, "state", "learning.json"))
	if w := apiCall(NewHandler(s), "GET", "/api/learning-paths", nil); w.Code != 500 {
		t.Fatal(w.Code)
	}
}
func TestLearningCAS(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	a := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningInput()))
	id := a["id"].(string)
	var wg sync.WaitGroup
	codes := make(chan int, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v := learningInput()
			v["version"] = 1
			codes <- apiCall(h, "PUT", "/api/learning-paths/"+id, v).Code
		}()
	}
	wg.Wait()
	close(codes)
	ok := 0
	for code := range codes {
		if code == 200 {
			ok++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if ok != 1 {
		t.Fatal(ok)
	}
}

func TestLearningChapterAndReferenceValidation(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	d := mustCreate(t, s, input("source"))
	for _, key := range []string{"accent", "title", "description", "chapters"} {
		v := learningInput()
		switch key {
		case "accent":
			v[key] = "red"
		case "title":
			v[key] = "unsafe\x00title"
		case "description":
			v[key] = strings.Repeat("a", 4001)
		case "chapters":
			v[key] = []any{map[string]any{"id": "a", "title": "", "description": "", "documentIds": []string{}}}
		}
		if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 400 {
			t.Fatal(key, w.Code)
		}
	}
	chapter := func(id string, docs []string) map[string]any {
		return map[string]any{"id": id, "title": "Chapter", "description": "", "documentIds": docs}
	}
	for _, chapters := range [][]any{
		{chapter("same", []string{}), chapter("same", []string{})},
		{chapter("one", []string{d.ID}), chapter("two", []string{d.ID})},
		{chapter("one", []string{"invalid"})},
	} {
		v := learningInput()
		v["chapters"] = chapters
		if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
	v := learningInput(strings.Repeat("a", 32))
	if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 404 {
		t.Fatal(w.Code)
	}
	v = learningInput()
	v["version"] = 1
	if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 400 {
		t.Fatal(w.Code)
	}
	chapters := []any{}
	for i := 0; i < 31; i++ {
		chapters = append(chapters, chapter(strings.Repeat("a", i+1), []string{}))
	}
	v = learningInput()
	v["chapters"] = chapters
	if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 400 {
		t.Fatal(w.Code)
	}
	docs := []string{}
	for i := 0; i < 301; i++ {
		docs = append(docs, fmt.Sprintf("%032x", i))
	}
	v = learningInput()
	v["chapters"] = []any{chapter("one", docs)}
	if w := apiCall(h, "POST", "/api/learning-paths", v); w.Code != 413 {
		t.Fatal(w.Code)
	}
	for _, method := range []string{"PATCH", "OPTIONS"} {
		if w := apiCall(h, method, "/api/learning-paths", nil); w.Code != 405 {
			t.Fatal(w.Code)
		}
	}
	if w := apiCall(h, "GET", "/api/learning-paths/bad-id", nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
}

func TestLearningStoredShapeAndAggregateBudget(t *testing.T) {
	s := testStore(t)
	now := s.now().UTC().Format(time.RFC3339Nano)
	state := newLearningFile()
	chapters := []LearningChapter{}
	for i := 0; i < 30; i++ {
		chapters = append(chapters, LearningChapter{ID: fmt.Sprint(i), Title: "Chapter", Description: strings.Repeat("<", 2000), DocumentIDs: []string{}})
	}
	for i := 0; i < 25; i++ {
		id := fmt.Sprintf("%032x", i)
		state.Paths[id] = LearningPath{ID: id, Title: "test", Description: "", Accent: "blue", Chapters: chapters, Version: 1, CreatedAt: now, UpdatedAt: now}
	}
	s.mu.Lock()
	err := s.saveLearningLocked(state)
	s.mu.Unlock()
	if known, ok := err.(*apiError); !ok || known.Status != 413 {
		t.Fatal("expected aggregate size budget", err)
	}
	if _, e := os.Stat(filepath.Join(s.root, "state", "learning.json")); !os.IsNotExist(e) {
		t.Fatal("failed commit wrote state", e)
	}
	id := strings.Repeat("b", 32)
	good := LearningPath{ID: id, Title: "test", Description: "", Accent: "violet", Chapters: []LearningChapter{}, Version: 1, CreatedAt: now, UpdatedAt: now}
	for _, mutate := range []func(*LearningPath){func(v *LearningPath) { v.Version = 0 }, func(v *LearningPath) { v.CreatedAt = "invalid" }, func(v *LearningPath) { v.Accent = "red" }} {
		state = newLearningFile()
		broken := good
		mutate(&broken)
		state.Paths[id] = broken
		data, _ := json.Marshal(state)
		os.WriteFile(filepath.Join(s.root, "state", "learning.json"), data, 0600)
		if w := apiCall(NewHandler(s), "GET", "/api/learning-paths", nil); w.Code != 500 {
			t.Fatal(w.Code)
		}
	}
}
