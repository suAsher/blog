package content

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type uploadTestFile struct {
	name string
	data []byte
}

func testPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	im := image.NewRGBA(image.Rect(0, 0, 2, 2))
	im.Set(0, 0, color.RGBA{R: 100, A: 255})
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func uploadRequest(t *testing.T, route string, paths []string, files []uploadTestFile) *http.Request {
	t.Helper()
	var b bytes.Buffer
	mw := multipart.NewWriter(&b)
	for _, file := range files {
		p, err := mw.CreateFormFile("files", file.name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = p.Write(file.data)
	}
	if paths != nil {
		data, _ := json.Marshal(paths)
		_ = mw.WriteField("paths", string(data))
	}
	_ = mw.Close()
	r := httptest.NewRequest("POST", route, &b)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}
func TestImportMarkdownAndRelativeImages(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := []uploadTestFile{{"note.md", []byte("---\ntitle: 原始文档\ntags: [自选标签]\n---\n# 标题\n\n![图](../images/chart.png)\n\n配图与技术内容。")}, {"chart.png", testPNG(t)}, {"readme.txt", []byte("纯文本笔记")}}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", []string{"garden/docs/note.md", "garden/images/chart.png", "garden/readme.txt"}, files))
	if w.Code != 200 {
		t.Fatalf("import status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		OK   bool `json:"ok"`
		Data struct {
			Imported   []Summary `json:"imported"`
			Unresolved []any     `json:"unresolvedImages"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || len(response.Data.Imported) != 2 || len(response.Data.Unresolved) != 0 {
		t.Fatalf("unexpected report %s", w.Body.String())
	}
	doc, err := s.Get(response.Data.Imported[0].ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "原始文档" || doc.Status != "draft" || !strings.Contains(doc.HTML, "/api/assets/") || !strings.Contains(doc.Source, "../images/chart.png") {
		t.Fatalf("bad imported document %+v", doc)
	}
	entries, err := os.ReadDir(filepath.Join(s.root, "tmp"))
	if err != nil || len(entries) != 0 {
		t.Fatal("temporary files were not cleaned")
	}
}
func TestImportRejectsTraversalAndReportsUnsupported(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"../escape.md", "/absolute.md", "a/../../bad.md", "a\\bad.md", "a/%2e%2e/bad.md"} {
		w := httptest.NewRecorder()
		s.importHTTP(w, uploadRequest(t, "/api/import", []string{p}, []uploadTestFile{{"note.md", []byte("# Note")}}))
		if w.Code != 400 {
			t.Fatalf("traversal accepted %q: %d", p, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", []string{".git/secret.md", "diagram.svg", "safe.md"}, []uploadTestFile{{"secret.md", []byte("private")}, {"diagram.svg", []byte(`<svg onload="alert(1)"/>`)}, {"safe.md", []byte("# 正常笔记")}}))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "skipped") || !strings.Contains(w.Body.String(), "正常笔记") {
		t.Fatalf("unsupported import %d %s", w.Code, w.Body.String())
	}
}
