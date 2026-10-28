package content

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoryHTTPListSnapshotPublishedRestoreAndErrors(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("first"))
	h := &handler{store: s}
	route := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.documentHistory(w, r, d.ID) })
	for _, test := range []struct {
		method, path string
		value        any
		status       int
	}{
		{"GET", "/history", nil, 200}, {"GET", "/history?revision=published", nil, 404}, {"GET", "/history?revision=invalid", nil, 400}, {"GET", "/history?revision=999", nil, 404}, {"POST", "/history", map[string]any{"unknown": 1}, 400}, {"DELETE", "/history", nil, 405},
	} {
		if w := apiCall(route, test.method, test.path, test.value); w.Code != test.status {
			t.Fatalf("%s %s => %d %s", test.method, test.path, w.Code, w.Body.String())
		}
	}
	var err error
	d, err = s.Update(d.ID, input("second"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	d, err = s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"", "?revision=1", "?revision=published"} {
		if w := apiCall(route, "GET", "/history"+query, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := apiCall(route, "POST", "/history", map[string]int{"version": d.Version, "revision": 1})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	restored := apiDetail(t, w)
	w = apiCall(route, "POST", "/history", map[string]int{"version": d.Version, "revision": 1})
	if w.Code != 409 {
		t.Fatal("restore CAS missing")
	}
	if _, err = s.RestoreHistory(d.ID, restored.Version, 999); err == nil {
		t.Fatal("unknown revision accepted")
	}
	unchanged, err := s.RestoreHistory(d.ID, restored.Version, 1)
	if err != nil || unchanged.Version != restored.Version {
		t.Fatal("no-op restore created revision", err)
	}
	if _, err = s.HistoryRevision("bad", 1); err == nil {
		t.Fatal("bad id accepted")
	}
	if _, err = s.publishedHistory("bad"); err == nil {
		t.Fatal("bad id accepted")
	}
}

func TestHistoryValidatesEachSnapshotBoundary(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	stored, err := s.loadLocked(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	entry := HistorySnapshot{HistorySummary: HistorySummary{Revision: 1, Title: stored.Working.Title, SavedAt: stored.UpdatedAt, Reason: "update"}, Content: stored.Working}
	for _, mutate := range []func(*record){
		func(d *record) { d.History[0].Reason = "unknown" },
		func(d *record) { d.History[0].SavedAt = "unknown" },
		func(d *record) { d.History[0].Title = "wrong" },
		func(d *record) { d.History[0].Content.Source = string([]byte{255}) },
		func(d *record) {
			d.History[0].Aliases = map[string]string{}
			for i := 0; i < 1001; i++ {
				d.History[0].Aliases[strings.Repeat("a", i+1)] = "x"
			}
		},
		func(d *record) { d.History = make([]HistorySnapshot, maxHistoryEntries+1) },
		func(d *record) {
			d.History = append(d.History, d.History[0])
			d.History[0].Content.Source = strings.Repeat("\t", int(MaxSourceBytes))
			d.History[1].Content.Source = d.History[0].Content.Source
		},
	} {
		value := *stored
		value.Version = 2
		value.History = []HistorySnapshot{entry}
		mutate(&value)
		if err := validateHistory(&value); err == nil {
			t.Fatal("unsafe history accepted")
		}
	}
}

func TestImportReportHTTPRetentionAndSafety(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	route := http.HandlerFunc(h.importReports)
	if w := apiCall(route, "POST", "/api/import/reports", nil); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if w := apiCall(route, "GET", "/api/import/reports?id=bad", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := apiCall(route, "GET", "/api/import/reports?id="+strings.Repeat("a", 32), nil); w.Code != 404 {
		t.Fatal(w.Code)
	}
	for i := 0; i < maxImportReports+2; i++ {
		id, err := newImportID()
		if err != nil {
			t.Fatal(err)
		}
		report := importReport{ID: id, CreatedAt: "2026-10-28T00:00:00Z", Fingerprint: strings.Repeat("a", 64), Imported: []Summary{}, Updated: []Summary{}, Outcomes: []importOutcome{}, Skipped: []importSkip{}, Unresolved: []unresolvedImage{}, Warnings: []string{}}
		if err = s.saveImportReport(report); err != nil {
			t.Fatal(err)
		}
	}
	reports, err := s.ImportReports("")
	if err != nil || len(reports.Reports) != maxImportReports {
		t.Fatal("retention failed", err)
	}
	if w := apiCall(route, "GET", "/api/import/reports?id="+reports.Reports[0].ID, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	name := filepath.Join(s.root, "state", "import-reports.json")
	data, _ := os.ReadFile(name)
	var state map[string]any
	_ = json.Unmarshal(data, &state)
	state["reports"].([]any)[0].(map[string]any)["createdAt"] = "bad"
	data, _ = json.Marshal(state)
	_ = os.WriteFile(name, data, 0600)
	if w := apiCall(route, "GET", "/api/import/reports", nil); w.Code != 500 {
		t.Fatal("corrupt report accepted", w.Code)
	}
	_ = os.Remove(name)
	outside := filepath.Join(t.TempDir(), "outside.json")
	_ = os.WriteFile(outside, []byte(`{"reports":[]}`), 0600)
	_ = os.Symlink(outside, name)
	if _, err := s.ImportReports(""); err == nil {
		t.Fatal("symlink report accepted")
	}
}

func TestImportPreviewHTTPBoundaryAndDecisionsValidation(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	route := http.HandlerFunc(h.importPreview)
	if w := apiCall(route, "GET", "/api/import/preview", nil); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if w := apiCall(route, "POST", "/api/import/preview", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	for _, value := range []importDecisions{
		{RequestID: "invalid"},
		{Paths: []importDecision{{Path: "../escape", Action: "create"}}},
		{Paths: []importDecision{{Path: "x.md", Action: "create"}, {Path: "x.md", Action: "skip"}}},
		{Paths: []importDecision{{Path: "x.md", Action: "overwrite"}}},
		{Paths: []importDecision{{Path: "x.md", Action: "update"}}},
		{Paths: []importDecision{{Path: "x.md", Action: "create", Version: 1}}},
	} {
		if err := validateImportDecisions(&value); err == nil {
			t.Fatalf("invalid decision accepted %+v", value)
		}
	}
	w := httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, []uploadTestFile{{"x.md", []byte("# X")}}, importDecisions{Paths: []importDecision{{Path: "missing.md", Action: "skip"}}}))
	if w.Code != 400 {
		t.Fatal("decision outside upload accepted", w.Code)
	}
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, []uploadTestFile{{"x.md", []byte("# X\n![x](" + strings.Repeat("a", 2049) + ")")}}))
	if w.Code != 413 {
		t.Fatal("reference byte budget missing", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, []uploadTestFile{{"x.md", []byte(strings.Repeat("![x](a) ", maxImportReferences+1))}}))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	} // Repeated destinations count once.
}
