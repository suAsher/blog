package content

import (
	"bytes"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInboxMethodsAndContentType(t *testing.T) {
	h := inboxTestHandler(testStore(t))
	for _, call := range []struct {
		method, path string
		status       int
	}{
		{"HEAD", "/api/inbox", 200},
		{"POST", "/api/inbox", 405},
		{"GET", "/api/inbox/batch", 405},
		{"POST", "/api/inbox/views", 405},
		{"GET", "/api/inbox/missing", 404},
		{"GET", "/api/inbox?q=%zz", 400},
	} {
		if w := apiCall(h, call.method, call.path, nil); w.Code != call.status {
			t.Fatal(call, w.Code)
		}
	}
	r := httptest.NewRequest("PUT", "/api/inbox/views", strings.NewReader(`{"version":0,"views":[]}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal(w.Code)
	}
}

func TestInboxViewsValidationAndBudget(t *testing.T) {
	h := inboxTestHandler(testStore(t))
	view := inboxView{ID: "saved", Name: "Saved", Filter: inboxFilter{View: "all"}}
	for _, views := range [][]inboxView{
		nil, {view, view},
		{{ID: "../escape", Name: "Saved", Filter: view.Filter}},
		{{ID: "a", Name: "", Filter: view.Filter}},
		{{ID: "a", Name: strings.Repeat("x", 61), Filter: view.Filter}},
		{{ID: "a", Name: "line\nbreak", Filter: view.Filter}},
		{{ID: "a", Name: "saved", Filter: inboxFilter{View: "unknown"}}},
	} {
		w := apiCall(h, "PUT", "/api/inbox/views", inboxViewsRequest{Version: 0, Views: views})
		if w.Code != 400 {
			t.Fatal(views, w.Code)
		}
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", inboxViewsRequest{Version: -1, Views: []inboxView{}}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	views := []inboxView{}
	for i := range maxInboxViews + 1 {
		views = append(views, inboxView{ID: fmt.Sprint(i), Name: "saved", Filter: view.Filter})
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", inboxViewsRequest{Version: 0, Views: views}); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", inboxViewsRequest{Version: 0, Views: views[:maxInboxViews]}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	ids := []string{}
	for i := range 101 {
		ids = append(ids, fmt.Sprintf("%032x", i))
	}
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(1, "organized", ids...)); w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestInboxPersistenceBudgetsAndExhaustedCAS(t *testing.T) {
	s := testStore(t)
	h := inboxTestHandler(s)
	d := mustCreate(t, s, input("untouched"))
	s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(0, "organized", d.ID)); w.Code != 507 {
		t.Fatal(w.Code)
	}
	if w := apiCall(h, "PUT", "/api/inbox/views", inboxViewsRequest{Views: []inboxView{}}); w.Code != 507 {
		t.Fatal(w.Code)
	}
	if result := inboxResult(t, h, ""); result.Version != 0 {
		t.Fatal("failed mutation advanced revision")
	}
	s.freeBytes = func() (int64, error) { return 1 << 40, nil }
	state := newInboxFile()
	state.Version = maxSafeRevision
	if err := s.saveInboxLocked(state); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/inbox/batch", "/api/inbox/views"} {
		var body any = inboxBatch(maxSafeRevision, "verified", d.ID)
		if strings.HasSuffix(path, "views") {
			body = inboxViewsRequest{Version: maxSafeRevision, Views: []inboxView{}}
		}
		if w := apiCall(h, "PUT", path, body); w.Code != 409 {
			t.Fatal(path, w.Code)
		}
	}
	state = newInboxFile()
	document, err := os.ReadFile(filepath.Join(s.root, "documents", d.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	for i := range maxInboxEntries {
		id := fmt.Sprintf("%032x", i)
		state.Entries[id] = inboxEntry{Stage: "organized", UpdatedAt: "2026-11-06T00:00:00Z"}
		// The budget applies to extant records; permanently deleted records are
		// reclaimed by the batch mutation before checking capacity.
		data := bytes.Replace(document, []byte(d.ID), []byte(id), 1)
		if err := os.WriteFile(filepath.Join(s.root, "documents", id+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.saveInboxLocked(state); err != nil {
		t.Fatal(err)
	}
	before := inboxStateBytes(t, s)
	if w := apiCall(h, "PUT", "/api/inbox/batch", inboxBatch(0, "verified", d.ID)); w.Code != 413 {
		t.Fatal(w.Code, w.Body.String())
	}
	if !bytes.Equal(before, inboxStateBytes(t, s)) {
		t.Fatal("entry budget failure changed persisted state")
	}
}

func TestInboxDamagedFilesAreExplicitErrors(t *testing.T) {
	for _, body := range []string{
		`{"schemaVersion":2,"version":0,"entries":{},"views":[]}`,
		`{"schemaVersion":1,"version":-1,"entries":{},"views":[]}`,
		`{"schemaVersion":1,"version":0,"entries":{"bad":{"stage":"organized","updatedAt":"2026-11-06T00:00:00Z"}},"views":[]}`,
		`{"schemaVersion":1,"version":0,"entries":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"stage":"wrong","updatedAt":"bad"}},"views":[]}`,
		strings.Repeat(" ", maxInboxBytes+1),
	} {
		s := testStore(t)
		os.WriteFile(filepath.Join(s.root, "state", "inbox.json"), []byte(body), 0600)
		if w := apiCall(inboxTestHandler(s), "GET", "/api/inbox", nil); w.Code != 500 {
			t.Fatal(w.Code)
		}
	}
	for _, mode := range []os.FileMode{0644, 0755} {
		s := testStore(t)
		path := filepath.Join(s.root, "state", "inbox.json")
		os.WriteFile(path, []byte(`{"schemaVersion":1,"version":0,"entries":{},"views":[]}`), mode)
		os.Chmod(path, mode)
		if w := apiCall(inboxTestHandler(s), "GET", "/api/inbox", nil); w.Code != 500 {
			t.Fatal(w.Code)
		}
	}
	s := testStore(t)
	d := mustCreate(t, s, input("source"))
	os.WriteFile(filepath.Join(s.root, "documents", d.ID+".json"), []byte("{}"), 0600)
	if w := apiCall(inboxTestHandler(s), "GET", "/api/inbox", nil); w.Code != 500 {
		t.Fatal("damaged document silently skipped", w.Code)
	}
	s = testStore(t)
	os.Chmod(filepath.Join(s.root, "state"), 0755)
	if w := apiCall(inboxTestHandler(s), "GET", "/api/inbox", nil); w.Code != 500 {
		t.Fatal(w.Code)
	}
}
