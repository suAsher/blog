package content

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadingHTTPBudgetsAndUntrustedInputs(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	for _, key := range []string{"", "__proto__", "constructor", "prototype", "bad\nkey", strings.Repeat("中", 81), "../escape"} {
		op := readingOperationInput(1, key, map[string]any{"read": 0}, map[string]any{"read": true})
		if w := apiCall(h, "POST", "/api/reading-state", map[string]any{"operations": []any{op}}); w.Code != 400 {
			t.Fatalf("unsafe key accepted %q: %s", key, w.Body.String())
		}
	}
	for _, op := range []map[string]any{
		readingOperationInput(1, "key", map[string]any{}, map[string]any{"read": true}),
		readingOperationInput(1, "key", map[string]any{"read": nil}, map[string]any{"read": true}),
		readingOperationInput(1, "key", map[string]any{"read": 0}, map[string]any{"read": nil}),
		readingOperationInput(1, "key", map[string]any{"read": 9007199254740992}, map[string]any{"read": true}),
		readingOperationInput(1, "key", map[string]any{"read": 1.5}, map[string]any{"read": true}),
		readingOperationInput(1, "key", map[string]any{"read": -1}, map[string]any{"read": true}),
		readingOperationInput(1, "key", map[string]any{"other": 0}, map[string]any{"other": true}),
		readingOperationInput(1, "key", map[string]any{"progress": 0}, map[string]any{"progress": -1}),
		readingOperationInput(1, "key", map[string]any{"review": 0}, map[string]any{"reviewAction": "unknown"}),
	} {
		if w := apiCall(h, "POST", "/api/reading-state", map[string]any{"operations": []any{op}}); w.Code != 400 {
			t.Fatal("invalid operation accepted", w.Body.String())
		}
	}
	op := readingOperationInput(1, "key", map[string]any{"read": 0}, map[string]any{"read": true})
	op["opId"] = "not-a-uuid"
	if w := apiCall(h, "POST", "/api/reading-state", map[string]any{"operations": []any{op}}); w.Code != 400 {
		t.Fatal("invalid operation ID accepted")
	}
	operations := []any{}
	for i := 0; i < 33; i++ {
		operations = append(operations, readingOperationInput(i+1, "key", map[string]any{"read": 0}, map[string]any{"read": true}))
	}
	if w := apiCall(h, "POST", "/api/reading-state", map[string]any{"operations": operations}); w.Code != 400 {
		t.Fatal("operation batch count unbounded")
	}
	if w := apiCall(h, "POST", "/api/reading-state", map[string]any{"operations": []any{readingOperationInput(1, strings.Repeat("a", 33<<10), map[string]any{"read": 0}, map[string]any{"read": true})}}); w.Code != 413 {
		t.Fatal("reading request body budget not explicit", w.Code)
	}
	for _, path := range []string{"/api/reviews?limit=0", "/api/reviews?limit=101", "/api/reviews?limit=x"} {
		if w := apiCall(h, "GET", path, nil); w.Code != 400 {
			t.Fatal("review limit not validated", path, w.Code)
		}
	}
	if apiCall(h, "PUT", "/api/reading-state", nil).Code != 405 || apiCall(h, "POST", "/api/reviews", nil).Code != 405 {
		t.Fatal("unsupported state method accepted")
	}
}

func TestReadingStateBudgetsCountBytesAndSafeRevisions(t *testing.T) {
	s := testStore(t)
	state := emptyReadingFile()
	state.Revision = 1
	for i := 0; i < 10000; i++ {
		state.Entries[fmt.Sprintf("note-%05d", i)] = ReadingEntry{}
	}
	s.mu.Lock()
	err := s.saveReadingLocked(state)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	newKey := readingOperationInput(1, "new-key", map[string]any{"read": 0}, map[string]any{"read": true})
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{newKey}}); w.Code != 413 {
		t.Fatal("entry count budget not enforced", w.Code)
	}
	for key := range state.Entries {
		delete(state.Entries, key)
	}
	for i := 0; i < 10000; i++ {
		stamp := "2026-10-26T00:00:00.123456789Z"
		state.Entries[strings.Repeat("x", 230)+fmt.Sprintf("%09d", i)] = ReadingEntry{FieldRevisions: FieldRevisions{Review: 1}, Review: &ReadingReview{Enabled: true, DueAt: &stamp, LastReviewedAt: &stamp}}
	}
	s.mu.Lock()
	err = s.saveReadingLocked(state)
	s.mu.Unlock()
	if known, ok := err.(*apiError); !ok || known.Status != 413 {
		t.Fatal("serialized state budget not enforced", err)
	}
	state = emptyReadingFile()
	state.Revision = maxSafeRevision
	s.mu.Lock()
	err = s.saveReadingLocked(state)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{newKey}}); w.Code != 503 {
		t.Fatal("unsafe revision overflow not stopped", w.Code)
	}
}

func TestReadingMalformedPersistedEntriesFailClosed(t *testing.T) {
	cases := []string{
		`{"schemaVersion":1,"revision":null,"entries":{},"receipts":[]}`,
		`{"schemaVersion":1,"revision":0,"entries":{},"receipts":null}`,
		`{"schemaVersion":1,"revision":0,"entries":{"key":null},"receipts":[]}`,
		`{"schemaVersion":1,"revision":0,"entries":{"key":{"bookmarked":false,"read":false,"progress":0,"updatedAt":0,"fieldRevisions":null}},"receipts":[]}`,
		`{"schemaVersion":2,"revision":0,"entries":{},"receipts":[]}`,
		`{"schemaVersion":1,"revision":9007199254740992,"entries":{},"receipts":[]}`,
	}
	for _, data := range cases {
		s := testStore(t)
		name := filepath.Join(s.root, "state", "reading.json")
		if err := os.WriteFile(name, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 {
			t.Fatal("corrupt persisted state returned200", data, w.Body.String())
		}
	}
	state := emptyReadingFile()
	state.Entries["key"] = ReadingEntry{FieldRevisions: FieldRevisions{Read: 2}}
	if err := validateReadingFile(state); err == nil {
		t.Fatal("field revision above global revision accepted")
	}
	state = emptyReadingFile()
	due := "bad time"
	state.Entries["key"] = ReadingEntry{Review: &ReadingReview{Enabled: true, DueAt: &due}}
	if err := validateReadingFile(state); err == nil {
		t.Fatal("invalid review timestamp accepted")
	}
	state = emptyReadingFile()
	state.Receipts = []readingReceipt{{OpID: "00000001-0000-4000-8000-000000000001", Key: "key", Fingerprint: strings.Repeat("z", 64), Applied: []string{"read"}}}
	if err := validateReadingFile(state); err == nil {
		t.Fatal("bad receipt hash accepted")
	}
}

func TestReadingStateDirectorySymlinksAndPrivatePermissions(t *testing.T) {
	s := testStore(t)
	if err := os.Remove(filepath.Join(s.root, "state")); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.root, "state")); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 {
		t.Fatal("state directory symlink accepted")
	}
	if _, err := NewStore(s.root); err == nil {
		t.Fatal("startup accepted symlink state directory")
	}
	s = testStore(t)
	readingPost(t, s, readingOperationInput(1, "key", map[string]any{"read": 0}, map[string]any{"read": true}))
	name := filepath.Join(s.root, "state", "reading.json")
	if err := os.Chmod(name, 0644); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 {
		t.Fatal("publicly readable state file accepted")
	}
	entries, err := os.ReadDir(filepath.Join(s.root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".reading-") {
			t.Fatal("temporary save file was left behind")
		}
	}
	s = testStore(t)
	if err := os.Chmod(filepath.Join(s.root, "state"), 0755); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 {
		t.Fatal("publicly accessible state directory accepted")
	}
}

func TestReadingHTTPRejectsUnknownTrailingNullAndWrongMedia(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	op := readingOperationInput(1, "note", map[string]any{"read": 0}, map[string]any{"read": true})
	op["unknown"] = true
	for _, payload := range []any{map[string]any{"operations": []any{op}}, map[string]any{"operations": nil}, map[string]any{"operations": []any{}}, map[string]any{"operations": []any{}, "unknown": true}} {
		if w := apiCall(h, "POST", "/api/reading-state", payload); w.Code != 400 {
			t.Fatal("unknown/null reading payload accepted", w.Body.String())
		}
	}
	data, _ := json.Marshal(map[string]any{"operations": []any{}})
	r := httptest.NewRequest("POST", "/api/reading-state", strings.NewReader(string(data)+" {}"))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("trailing JSON accepted")
	}
	r = httptest.NewRequest("POST", "/api/reading-state", strings.NewReader("{}"))
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("wrong media accepted")
	}
}

func TestReadingStateRejectsSymlinksAndCorruptedFiles(t *testing.T) {
	s := testStore(t)
	readingPost(t, s, readingOperationInput(1, "key", map[string]any{"read": 0}, map[string]any{"read": true}))
	name := filepath.Join(s.root, "state", "reading.json")
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "private.json")
	if err := os.WriteFile(outside, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, name); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 || strings.Contains(w.Body.String(), "private.json") {
		t.Fatal("symlink state read accepted/leaked path")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(`{"schemaVersion":1,"revision":0,"entries":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(NewHandler(s), "GET", "/api/reading-state", nil); w.Code != 500 {
		t.Fatal("corrupt state silently reset")
	}
}
