package content

import (
	"bytes"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadPathValidation(t *testing.T) {
	for _, value := range []string{"", "../escape.md", "/abs.md", "x\\y.md", "a:b.md", "a//b.md", "a/./b.md", "a/%2e%2e/b.md", "a/%00.md", "a/line\n.md", strings.Repeat("x", 2049)} {
		if _, err := safeUploadPath(value); err == nil {
			t.Errorf("unsafe path accepted %q", value)
		}
	}
	for _, value := range []string{"100% notes.md", "百分号 % 文档.md", "space/docs/a.md", "literal%xx.md"} {
		if actual, err := safeUploadPath(value); err != nil || actual != value {
			t.Errorf("valid path rejected %q: %v", value, err)
		}
	}
	for _, value := range []string{"https://example.invalid/a.png", "//example.invalid/a.png", "../../escape.png", "..\\bad.png", "/%2fexternal"} {
		if _, valid := imageRelativePath("docs/note.md", value); valid {
			t.Errorf("unsafe image reference accepted %q", value)
		}
	}
}

func TestMultipartBoundaryLimitsAndCleanup(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	w := httptest.NewRecorder()
	s.importHTTP(w, httptest.NewRequest("POST", "/api/import", strings.NewReader("not multipart")))
	if w.Code != 400 {
		t.Fatal("nonmultipart body accepted")
	}
	large := httptest.NewRequest("POST", "/api/import", nil)
	large.ContentLength = MaxUploadBytes + 1
	w = httptest.NewRecorder()
	s.importHTTP(w, large)
	if w.Code != 413 {
		t.Fatal("oversized batch accepted")
	}
	empty := uploadRequest(t, "/api/import", nil, nil)
	w = httptest.NewRecorder()
	s.importHTTP(w, empty)
	if w.Code != 400 {
		t.Fatal("empty batch accepted")
	}
	cases := []func(*multipart.Writer){
		func(m *multipart.Writer) { _ = m.WriteField("paths", "{}") },
		func(m *multipart.Writer) { _ = m.WriteField("paths", "[]"); _ = m.WriteField("paths", "[]") },
		func(m *multipart.Writer) { _ = m.WriteField("unexpected", "x") },
	}
	for _, prepare := range cases {
		var data bytes.Buffer
		multipartBody := multipart.NewWriter(&data)
		prepare(multipartBody)
		_ = multipartBody.Close()
		request := httptest.NewRequest("POST", "/api/import", &data)
		request.Header.Set("Content-Type", multipartBody.FormDataContentType())
		w := httptest.NewRecorder()
		s.importHTTP(w, request)
		if w.Code != 400 {
			t.Fatalf("bad multipart accepted %d", w.Code)
		}
	}
	var data bytes.Buffer
	body := multipart.NewWriter(&data)
	for i := 0; i < 501; i++ {
		part, _ := body.CreateFormFile("files", "note.md")
		_, _ = part.Write([]byte("x"))
	}
	_ = body.Close()
	request := httptest.NewRequest("POST", "/api/import", &data)
	request.Header.Set("Content-Type", body.FormDataContentType())
	w = httptest.NewRecorder()
	s.importHTTP(w, request)
	if w.Code != 413 {
		t.Fatal("too many files accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(s.root, "tmp"))
	if len(entries) != 0 {
		t.Fatal("failed multipart staging left files")
	}
	uploadSlot <- struct{}{}
	w = httptest.NewRecorder()
	started := beginUpload(w)
	<-uploadSlot
	if started || w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("upload concurrency unbounded")
	}
}

func TestImageStorageRejectsCorruptionAndSymlinks(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	staged := filepath.Join(t.TempDir(), "image.png")
	_ = os.WriteFile(staged, testPNG(t), 0600)
	saved, err := s.saveAsset(staged, "image.png")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(s.root, "assets", strings.TrimPrefix(saved.URL, "/api/assets/"))
	_ = os.Remove(target)
	_ = os.Symlink(staged, target)
	if _, err := s.saveAsset(staged, "image.png"); err == nil {
		t.Fatal("symlink target reused")
	}
	if _, err := openAsset(s.root, strings.TrimPrefix(saved.URL, "/api/assets/")); err == nil {
		t.Fatal("symlink asset served")
	}
	_ = os.Remove(target)
	_ = os.WriteFile(target, []byte("corrupt"), 0600)
	if _, err := s.saveAsset(staged, "image.png"); err == nil {
		t.Fatal("corrupt existing asset reused")
	}
	_ = os.Remove(target)
	s.freeBytes = func() (int64, error) { return ReserveBytes, nil }
	if _, err := s.saveAsset(staged, "image.png"); err == nil {
		t.Fatal("asset write ignored storage reserve")
	}
	if _, err := inspectImage(staged + "-missing"); err == nil {
		t.Fatal("missing staged image accepted")
	}
	huge := filepath.Join(t.TempDir(), "huge.png")
	file, _ := os.Create(huge)
	_ = file.Truncate(MaxImageBytes + 1)
	file.Close()
	if _, err := inspectImage(huge); err == nil {
		t.Fatal("oversized image accepted")
	}
}

type failedZipWriter struct{ header http.Header }

func (w *failedZipWriter) Header() http.Header       { return w.header }
func (w *failedZipWriter) WriteHeader(int)           {}
func (w *failedZipWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestZipWriteFailureAbortsInsteadOfCompletingTruncatedArchive(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	doc, err := s.Create(Content{Title: "导出", Source: "正文"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if recovered := recover(); !errors.Is(asError(recovered), http.ErrAbortHandler) {
			t.Fatalf("expected stream abort, got %v", recovered)
		}
	}()
	s.exportHTTP(&failedZipWriter{header: make(http.Header)}, httptest.NewRequest("GET", "/api/documents/"+doc.ID+"/export?format=zip", nil), doc.ID)
}
func asError(value any) error { err, _ := value.(error); return err }

func TestExportChecksPublishedViewAndBrokenAssets(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	doc, err := s.Create(Content{Title: "原文", Source: "正文"}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.exportHTTP(w, httptest.NewRequest("GET", "/api/documents/"+doc.ID+"/export?view=published", nil), doc.ID)
	if w.Code != 404 {
		t.Fatal("unpublished export accepted")
	}
	s.mu.Lock()
	record, err := s.loadLocked(doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Aliases = map[string]string{"missing.png": "/api/assets/" + strings.Repeat("a", 64) + ".png"}
	err = s.saveLocked(record)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	s.exportHTTP(w, httptest.NewRequest("GET", "/api/documents/"+doc.ID+"/export?format=zip", nil), doc.ID)
	if w.Code != 409 {
		t.Fatal("missing asset silently omitted from ZIP")
	}
}
