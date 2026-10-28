package content

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func decisionUpload(t *testing.T, files []uploadTestFile, options any) *http.Request {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for _, f := range files {
		part, err := mw.CreateFormFile("files", f.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(f.data)
	}
	encoded, _ := json.Marshal(options)
	_ = mw.WriteField("decisions", string(encoded))
	_ = mw.Close()
	r := httptest.NewRequest("POST", "/api/import", &b)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}
func decodeImport(t *testing.T, w *httptest.ResponseRecorder) importReport {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("status=%d %s", w.Code, w.Body.String())
	}
	var value struct {
		Data importReport `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value.Data
}
func TestImportPreviewDoesNotPersistAndClassifiesDuplicate(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	files := []uploadTestFile{{"note.md", []byte("# Note\n![missing](missing.png)")}, {"cover.png", testPNG(t)}}
	w := httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, files))
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var preview struct {
		Data importPreview `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &preview)
	if len(preview.Data.Candidates) != 1 || preview.Data.Candidates[0].Status != "new" || len(preview.Data.Unresolved) != 1 {
		t.Fatalf("bad preview %s", w.Body.String())
	}
	for _, dir := range []string{"documents", "assets", "tmp"} {
		entries, err := os.ReadDir(filepath.Join(s.root, dir))
		if err != nil || len(entries) != 0 {
			t.Fatalf("preview persisted %s", dir)
		}
	}
	w = httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, files))
	report := decodeImport(t, w)
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, files))
	_ = json.Unmarshal(w.Body.Bytes(), &preview)
	if preview.Data.Candidates[0].Status != "duplicate" || preview.Data.Candidates[0].ExistingID != report.Imported[0].ID {
		t.Fatalf("duplicate missing %s", w.Body.String())
	}
	files[0].data = []byte("# Changed")
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, files))
	_ = json.Unmarshal(w.Body.Bytes(), &preview)
	if preview.Data.Candidates[0].Status != "changed" {
		t.Fatalf("changed missing %s", w.Body.String())
	}
}
func TestImportDecisionsCASReportsAndIdempotentRetry(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"note.md", []byte("# First")}}
	options := importDecisions{RequestID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Paths: []importDecision{{Path: "note.md", Action: "create"}}}
	w := httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report := decodeImport(t, w)
	if len(report.Imported) != 1 || report.ID != options.RequestID {
		t.Fatal("missing import/report", w.Body.String())
	}
	d := report.Imported[0]
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	retry := decodeImport(t, w)
	if retry.Imported[0].ID != d.ID {
		t.Fatal("retry duplicated success")
	}
	list, _ := s.List(ListOptions{Status: "draft", Limit: 100})
	if list.Total != 1 {
		t.Fatal("retry persisted duplicate")
	}
	options.RequestID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	options.Paths = nil
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report = decodeImport(t, w)
	if len(report.Imported) != 0 || len(report.Skipped) != 1 {
		t.Fatal("safe flow duplicated")
	}
	files[0].data = []byte("# Changed")
	options.RequestID = "cccccccccccccccccccccccccccccccc"
	options.Paths = []importDecision{{Path: "note.md", Action: "update", ExistingID: d.ID, Version: d.Version}}
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report = decodeImport(t, w)
	if len(report.Updated) != 1 || report.Updated[0].ID != d.ID {
		t.Fatal("update decision failed", w.Body.String())
	}
	options.RequestID = "dddddddddddddddddddddddddddddddd"
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report = decodeImport(t, w)
	if len(report.Updated) != 0 || len(report.Skipped) != 1 {
		t.Fatal("stale update overwrote")
	}
	restarted, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	reports, err := restarted.ImportReports("")
	if err != nil || len(reports.Reports) != 4 {
		t.Fatal("reports not durable", reports, err)
	}
}
func TestImportPreviewInvalidImageUTF8AndMetadata(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	w := httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, []uploadTestFile{{"broken.md", []byte{255}}, {"meta.md", []byte("---\ntitle: [bad\n---\nbody")}, {"bad.png", []byte("fake")}, {"fine.md", []byte("# Fine")}}))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var preview struct {
		Data importPreview `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &preview)
	if len(preview.Data.Candidates) != 3 || len(preview.Data.Skipped) != 1 || preview.Data.Candidates[0].Status != "invalid" {
		t.Fatal("invalid input not reported", w.Body.String())
	}
}

func TestImportPreviewExplicitDateAndChangedImageAreNotDuplicates(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	files := []uploadTestFile{{"note.md", []byte("---\ndate: 2026-10-25\n---\n# Note\n![image](pic.png)")}, {"pic.png", testPNG(t)}}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, files))
	decodeImport(t, w)
	files[0].data = []byte("---\ndate: 2026-10-26\n---\n# Note\n![image](pic.png)")
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, files))
	var result struct {
		Data importPreview `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result.Data.Candidates[0].Status != "changed" {
		t.Fatal("explicit date edit lost", w.Body.String())
	}
	files[0].data = []byte("---\ndate: 2026-10-25\n---\n# Note\n![image](pic.png)")
	// A PNG text chunk is not needed: appending bytes preserves image validity and changes its content hash.
	files[1].data = append(files[1].data, 1)
	w = httptest.NewRecorder()
	h.importPreview(w, uploadRequest(t, "/api/import/preview", nil, files))
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result.Data.Candidates[0].Status != "changed" {
		t.Fatal("changed attachment treated as duplicate", w.Body.String())
	}
}

func TestImportReceiptRecoversAfterReportFailureAndRejectsReusedID(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"note.md", []byte("# First")}}
	options := importDecisions{RequestID: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", Paths: []importDecision{{Path: "note.md", Action: "create"}}}
	w := httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report := decodeImport(t, w)
	if err := os.Remove(filepath.Join(s.root, "state", "import-reports.json")); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	retry := decodeImport(t, w)
	if len(retry.Imported) != 1 || retry.Imported[0].ID != report.Imported[0].ID {
		t.Fatal("receipt retry lost successful import", w.Body.String())
	}
	if err := os.Remove(filepath.Join(s.root, "state", "import-reports.json")); err != nil {
		t.Fatal(err)
	}
	files[0].data = []byte("# Different")
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	if w.Code != 409 {
		t.Fatal("request id reuse after report failure accepted", w.Code, w.Body.String())
	}
}

func TestImportPreviewChecksCommitSpaceBeyondStaging(t *testing.T) {
	s := testStore(t)
	h := &handler{store: s}
	request := uploadRequest(t, "/api/import/preview", nil, []uploadTestFile{{"note.md", []byte("# Note")}})
	s.freeBytes = func() (int64, error) { return ReserveBytes + request.ContentLength + 1, nil }
	w := httptest.NewRecorder()
	h.importPreview(w, request)
	if w.Code != 507 {
		t.Fatal("preview failed to budget persisted document/report", w.Code, w.Body.String())
	}
}

func TestImportUpdateAndHistoryRestorePreservePublishedImage(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"note.md", []byte("# Note\n![image](pic.png)")}, {"pic.png", testPNG(t)}}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, files))
	report := decodeImport(t, w)
	d, err := s.Action(report.Imported[0].ID, "publish", 1)
	if err != nil {
		t.Fatal(err)
	}
	published, err := s.Get(d.ID, "published")
	if err != nil {
		t.Fatal(err)
	}
	files[1].data = append(files[1].data, 1)
	options := importDecisions{RequestID: "ffffffffffffffffffffffffffffffff", Paths: []importDecision{{Path: "note.md", Action: "update", ExistingID: d.ID, Version: d.Version}}}
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report = decodeImport(t, w)
	if len(report.Updated) != 1 {
		t.Fatal(w.Body.String())
	}
	working, err := s.Get(d.ID, "")
	if err != nil || working.HTML == published.HTML || !working.HasUnpublishedChanges {
		t.Fatal("image-only import not recognized", err)
	}
	live, err := s.Get(d.ID, "published")
	if err != nil || live.HTML != published.HTML {
		t.Fatal("working image import changed published image", err)
	}
	d, err = s.Action(d.ID, "publish", working.Version)
	if err != nil {
		t.Fatal(err)
	}
	latest, err := s.Get(d.ID, "published")
	if err != nil || latest.HTML == published.HTML {
		t.Fatal("republish did not adopt working image", err)
	}
	d, err = s.RestoreHistory(d.ID, d.Version, 1)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := s.Get(d.ID, "")
	if err != nil || restored.HTML != published.HTML || !restored.HasUnpublishedChanges {
		t.Fatal("image history not restored", err)
	}
	live, err = s.Get(d.ID, "published")
	if err != nil || live.HTML != latest.HTML {
		t.Fatal("history restore changed published image", err)
	}
}

func TestLegacyPublishedAliasesArePreservedOnImportAndHistoryRestore(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"note.md", []byte("# Note\n![image](pic.png)")}, {"pic.png", testPNG(t)}}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, files))
	report := decodeImport(t, w)
	d, err := s.Action(report.Imported[0].ID, "publish", 1)
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(s.root, "documents", d.ID+".json")
	data, _ := os.ReadFile(name)
	var raw map[string]any
	_ = json.Unmarshal(data, &raw)
	delete(raw, "publishedAliases")
	data, _ = json.Marshal(raw)
	_ = os.WriteFile(name, data, 0600)
	previous, err := s.Get(d.ID, "published")
	if err != nil {
		t.Fatal("legacy published alias fallback failed", err)
	}
	files[1].data = append(files[1].data, 1)
	options := importDecisions{RequestID: "abcdefabcdefabcdefabcdefabcdefab", Paths: []importDecision{{Path: "note.md", Action: "update", ExistingID: d.ID, Version: d.Version}}}
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report = decodeImport(t, w)
	if len(report.Updated) != 1 {
		t.Fatal(w.Body.String())
	}
	after, err := s.Get(d.ID, "published")
	if err != nil || after.HTML != previous.HTML {
		t.Fatal("legacy published alias changed after working import", err)
	}
}

func TestImportReportsEvictByBytesAndHistoryEvictsByBytes(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input(strings.Repeat("x", int(MaxSourceBytes)-100)))
	for i := 0; i < 4; i++ {
		c := input(strings.Repeat(string(rune('a'+i)), int(MaxSourceBytes)-100))
		var err error
		d, err = s.Update(d.ID, c, d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	history, err := s.History(d.ID)
	if err != nil || len(history.History) > 3 || len(history.History) < 1 {
		t.Fatal("history byte retention failed", history, err)
	}
	for i := 0; i < 3; i++ {
		id, err := newImportID()
		if err != nil {
			t.Fatal(err)
		}
		report := importReport{ID: id, CreatedAt: "2026-10-28T00:00:00Z", Fingerprint: strings.Repeat("a", 64), Warnings: []string{strings.Repeat("x", 3<<20)}}
		if err = s.saveImportReport(report); err != nil {
			t.Fatal(err)
		}
	}
	reports, err := s.ImportReports("")
	if err != nil || len(reports.Reports) != 2 {
		t.Fatal("report byte retention failed", len(reports.Reports), err)
	}
}

func TestImportReportDoesNotAmplifyHTMLCharactersAfterCommit(t *testing.T) {
	s := testStore(t)
	var source strings.Builder
	source.WriteString("# Report\n")
	for i := 0; i < maxImportReferences; i++ {
		source.WriteString("![image](" + strings.Repeat("&", 1980) + strconv.Itoa(i) + ".png)\n")
	}
	options := importDecisions{RequestID: "1234567890abcdef1234567890abcdef", Paths: []importDecision{{Path: "note.md", Action: "create"}}}
	files := []uploadTestFile{{"note.md", []byte(source.String())}}
	w := httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report := decodeImport(t, w)
	if len(report.Imported) != 1 || len(report.Unresolved) != maxImportReferences {
		t.Fatal("diagnostics not preserved", w.Body.String())
	}
	w = httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	retry := decodeImport(t, w)
	if retry.Imported[0].ID != report.Imported[0].ID {
		t.Fatal("report retry duplicated successful document")
	}
}

func TestCompletedImportRetryReturnsReportBeforeCommitBudgetCheck(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"note.md", []byte("# First")}}
	options := importDecisions{RequestID: "1234567890abcdef1234567890abcdee", Paths: []importDecision{{Path: "note.md", Action: "create"}}}
	w := httptest.NewRecorder()
	s.importHTTP(w, decisionUpload(t, files, options))
	report := decodeImport(t, w)
	request := decisionUpload(t, files, options)
	s.freeBytes = func() (int64, error) { return ReserveBytes + request.ContentLength + 1, nil }
	w = httptest.NewRecorder()
	s.importHTTP(w, request)
	retry := decodeImport(t, w)
	if retry.Imported[0].ID != report.Imported[0].ID {
		t.Fatal("completed retry lost report")
	}
}

func TestImportRejectsOversizedReportBeforeSavingDocumentsOrImages(t *testing.T) {
	s := testStore(t)
	files := []uploadTestFile{{"pic.png", testPNG(t)}}
	for i := 0; i < 300; i++ {
		name := strings.Repeat(`"`, 1980) + strconv.Itoa(i) + ".md"
		destination := strings.Repeat(`"`, 1980) + strconv.Itoa(i) + ".png"
		source := "# Budget\n![one](<" + destination + ">)\n![two](<" + destination + "x>)\n![fallback](images/pic.png)"
		files = append(files, uploadTestFile{name, []byte(source)})
	}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, files))
	if w.Code != 413 {
		t.Fatal("oversized report not rejected before commit", w.Code, w.Body.String()[:min(w.Body.Len(), 300)])
	}
	for _, directory := range []string{"documents", "assets", "tmp"} {
		entries, err := os.ReadDir(filepath.Join(s.root, directory))
		if err != nil || len(entries) != 0 {
			t.Fatalf("oversized report persisted %s", directory)
		}
	}
}
