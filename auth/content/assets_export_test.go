package content

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAssetsValidateDeduplicateAndServe(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data := testPNG(t)
	var assetURL string
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		s.assetsHTTP(w, uploadRequest(t, "/api/assets", nil, []uploadTestFile{{"image.png", data}}), "")
		if w.Code != 200 {
			t.Fatalf("asset upload %d %s", w.Code, w.Body.String())
		}
		var response struct {
			Data struct {
				Assets []assetInfo `json:"assets"`
			} `json:"data"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &response)
		if len(response.Data.Assets) != 1 {
			t.Fatal("missing asset")
		}
		assetURL = response.Data.Assets[0].URL
	}
	entries, _ := os.ReadDir(filepath.Join(s.root, "assets"))
	if len(entries) != 1 {
		t.Fatal("duplicate asset written")
	}
	w := httptest.NewRecorder()
	s.assetsHTTP(w, httptest.NewRequest("GET", assetURL, nil), strings.TrimPrefix(assetURL, "/api/assets/"))
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) || w.Header().Get("Content-Type") != "image/png" {
		t.Fatal("asset could not be served")
	}
	for _, file := range []uploadTestFile{{"script.svg", []byte(`<svg><script>alert(1)</script></svg>`)}, {"fake.png", []byte("not an image")}, {".private.png", data}} {
		w := httptest.NewRecorder()
		s.assetsHTTP(w, uploadRequest(t, "/api/assets", nil, []uploadTestFile{file}), "")
		if w.Code != 400 {
			t.Fatalf("unsafe image accepted %s %d", file.name, w.Code)
		}
	}
	for _, id := range []string{"../documents/doc.json", "bad.png", strings.Repeat("a", 64) + ".png"} {
		w := httptest.NewRecorder()
		s.assetsHTTP(w, httptest.NewRequest("GET", "/api/assets/anything", nil), id)
		if w.Code != 404 {
			t.Fatal("unsafe/missing asset path accepted")
		}
	}
}
func TestExportMarkdownAndPortableImageZip(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := []uploadTestFile{{"note.md", []byte("---\ntitle: 含图笔记\ncover: ../images/a.png\n---\n# 原文\n![图](../images/a.png)\n")}, {"a.png", testPNG(t)}}
	imported := httptest.NewRecorder()
	s.importHTTP(imported, uploadRequest(t, "/api/import", []string{"space/docs/note.md", "space/images/a.png"}, files))
	if imported.Code != 200 {
		t.Fatal(imported.Body.String())
	}
	var report struct {
		Data importReport `json:"data"`
	}
	_ = json.Unmarshal(imported.Body.Bytes(), &report)
	if len(report.Data.Imported) != 1 {
		t.Fatal(imported.Body.String())
	}
	id := report.Data.Imported[0].ID
	plain := httptest.NewRecorder()
	s.exportHTTP(plain, httptest.NewRequest("GET", "/api/documents/"+id+"/export", nil), id)
	if plain.Code != 200 || !strings.HasPrefix(plain.Body.String(), "---\n") || !strings.Contains(plain.Body.String(), "title: 含图笔记") || !strings.Contains(plain.Header().Get("Content-Disposition"), "attachment") {
		t.Fatal("invalid markdown export")
	}
	zipped := httptest.NewRecorder()
	s.exportHTTP(zipped, httptest.NewRequest("GET", "/api/documents/"+id+"/export?format=zip", nil), id)
	if zipped.Code != 200 {
		t.Fatal(zipped.Body.String())
	}
	archive, err := zip.NewReader(bytes.NewReader(zipped.Body.Bytes()), int64(zipped.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string][]byte{}
	for _, file := range archive.File {
		if strings.HasPrefix(file.Name, "/") || strings.Contains(file.Name, "../") {
			t.Fatal("unsafe ZIP entry")
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		entries[file.Name], err = io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(string(entries["space/docs/note.md"]), "../images/a.png") || !bytes.Equal(entries["space/images/a.png"], testPNG(t)) {
		t.Fatalf("ZIP lost relative image: %v", entries)
	}
	badFormat := httptest.NewRecorder()
	s.exportHTTP(badFormat, httptest.NewRequest("GET", "/api/documents/"+id+"/export?format=exe", nil), id)
	if badFormat.Code != 400 {
		t.Fatal("unsupported export format")
	}
}
func TestUploadCapacityAndPathGuards(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.freeBytes = func() (int64, error) { return ReserveBytes + 100, nil }
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, []uploadTestFile{{"note.md", []byte("# Note")}}))
	if w.Code != 507 {
		t.Fatal("low capacity accepted")
	}
	s.freeBytes = func() (int64, error) { return 0, errors.New("filesystem unavailable") }
	w = httptest.NewRecorder()
	s.assetsHTTP(w, uploadRequest(t, "/api/assets", nil, []uploadTestFile{{"a.png", testPNG(t)}}), "")
	if w.Code != 503 {
		t.Fatal("quota check failure not reported")
	}
	s.freeBytes = func() (int64, error) { return 1 << 40, nil }
	w = httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, []uploadTestFile{{"../escape.md", []byte("# x")}}))
	if w.Code != 400 {
		t.Fatal("raw multipart filename traversal accepted")
	}
	w = httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", []string{"one.md", "two.md"}, []uploadTestFile{{"one.md", []byte("# x")}}))
	if w.Code != 400 {
		t.Fatal("mismatched paths accepted")
	}
	w = httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", []string{"one.md", "one.md"}, []uploadTestFile{{"one.md", []byte("# x")}, {"two.md", []byte("# x")}}))
	if w.Code != 400 {
		t.Fatal("duplicate paths accepted")
	}
	entries, _ := os.ReadDir(filepath.Join(s.root, "tmp"))
	if len(entries) != 0 {
		t.Fatal("failed uploads left temporary files")
	}
}
func TestImportMetadataAndMissingImages(t *testing.T) {
	cases := []struct {
		name, body string
		valid      bool
	}{
		{"bom.md", "\ufeff---\r\ntitle: 元数据\r\ndate: 2026-10-25\r\ntags: a,b\r\n---\r\n# 内容", true},
		{"empty.md", "  ", false}, {"bad.md", string([]byte{255, 0}), false}, {"bad.md", "---\ntitle: invalid\n", false},
		{"bad.md", "---\ntags: {wrong: format}\n---\n正文", false}, {"note.txt", "plain text", true},
	}
	for _, item := range cases {
		c, err := parseImported(item.name, []byte(item.body))
		if (err == nil) != item.valid {
			t.Fatalf("metadata validity %q: %v", item.body, err)
		}
		if item.valid && c.Source == "" {
			t.Fatal("empty parsed source")
		}
	}
	s, _ := NewStore(t.TempDir())
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, []uploadTestFile{{"note.md", []byte("# 缺图\n![图](missing.png)\n![外部](https://example.invalid/image.png)")}}))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var report struct {
		Data importReport `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &report)
	if len(report.Data.Unresolved) != 2 || len(report.Data.Imported) != 1 {
		t.Fatal("missing images not reported")
	}
}

func TestPortableZipRoundTripUnicodePercentAndEditorAssets(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reportResponse := httptest.NewRecorder()
	s.importHTTP(reportResponse, uploadRequest(t, "/api/import", []string{"归档/文档/100% 学习.md", "归档/图片/图 100%.png"}, []uploadTestFile{{"100% 学习.md", []byte("---\ntitle: 中文与百分号\ncover: ../图片/图 100%.png\n---\n# 正文\n![旧图](<../图片/图 100%.png>)\n")}, {"图 100%.png", testPNG(t)}}))
	if reportResponse.Code != 200 {
		t.Fatal(reportResponse.Body.String())
	}
	var imported struct {
		Data importReport `json:"data"`
	}
	_ = json.Unmarshal(reportResponse.Body.Bytes(), &imported)
	if len(imported.Data.Imported) != 1 || len(imported.Data.Unresolved) != 0 {
		t.Fatal(reportResponse.Body.String())
	}
	doc, err := s.Get(imported.Data.Imported[0].ID, "")
	if err != nil {
		t.Fatal(err)
	}
	assetResponse := httptest.NewRecorder()
	s.assetsHTTP(assetResponse, uploadRequest(t, "/api/assets", nil, []uploadTestFile{{"new.png", testPNG(t)}}), "")
	var uploaded struct {
		Data struct {
			Assets []assetInfo `json:"assets"`
		} `json:"data"`
	}
	_ = json.Unmarshal(assetResponse.Body.Bytes(), &uploaded)
	if assetResponse.Code != 200 || len(uploaded.Data.Assets) != 1 {
		t.Fatal(assetResponse.Body.String())
	}
	imageURL := uploaded.Data.Assets[0].URL
	working := Content{Title: doc.Title, Description: doc.Description, Date: doc.Date, Tags: doc.Tags, Category: doc.Category, Cover: doc.Cover, Source: doc.Source + "\n![新图](" + imageURL + ")\n"}
	doc, err = s.Update(doc.ID, working, doc.Version)
	if err != nil {
		t.Fatal(err)
	}
	zipped := httptest.NewRecorder()
	s.exportHTTP(zipped, httptest.NewRequest("GET", "/api/documents/"+doc.ID+"/export?format=zip", nil), doc.ID)
	archive, err := zip.NewReader(bytes.NewReader(zipped.Body.Bytes()), int64(zipped.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	files := []uploadTestFile{}
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, entry.Name)
		files = append(files, uploadTestFile{filepath.Base(entry.Name), data})
	}
	roundTrip := httptest.NewRecorder()
	s.importHTTP(roundTrip, uploadRequest(t, "/api/import", names, files))
	if roundTrip.Code != 200 {
		t.Fatal(roundTrip.Body.String())
	}
	var restored struct {
		Data importReport `json:"data"`
	}
	_ = json.Unmarshal(roundTrip.Body.Bytes(), &restored)
	if len(restored.Data.Imported) != 1 || len(restored.Data.Unresolved) != 0 {
		t.Fatalf("roundtrip lost images %s", roundTrip.Body.String())
	}
	restoredDoc, err := s.Get(restored.Data.Imported[0].ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(restoredDoc.HTML, "/api/assets/") < 2 || restoredDoc.Cover == "" {
		t.Fatal("roundtrip lost body image or cover")
	}
}

func TestDirectoryImageAssociationNeverGuessesOtherFolder(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", []string{"garden/note.md", "garden/backup/chart.png"}, []uploadTestFile{{"note.md", []byte("# Note\n![图](missing/chart.png)")}, {"chart.png", testPNG(t)}}))
	var response struct {
		Data importReport `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 200 || len(response.Data.Unresolved) != 1 {
		t.Fatal("directory import guessed an unrelated image")
	}
	flat := httptest.NewRecorder()
	s.importHTTP(flat, uploadRequest(t, "/api/import", nil, []uploadTestFile{{"note.md", []byte("# Note\n![图](images/chart.png)")}, {"chart.png", testPNG(t)}}))
	_ = json.Unmarshal(flat.Body.Bytes(), &response)
	if flat.Code != 200 || len(response.Data.Unresolved) != 0 || len(response.Data.Warnings) == 0 {
		t.Fatal("flat selection fallback was not reported")
	}
}

func TestSmallUploadWithLimitedButSufficientSpace(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	s.freeBytes = func() (int64, error) { return ReserveBytes + (1 << 20), nil }
	w := httptest.NewRecorder()
	s.importHTTP(w, uploadRequest(t, "/api/import", nil, []uploadTestFile{{"small.md", []byte("# 小文档\n正常导入")}}))
	if w.Code != 200 {
		t.Fatalf("small upload rejected despite sufficient space: %s", w.Body.String())
	}
}

type gatedUploadReader struct {
	reader  io.Reader
	started chan struct{}
	release chan struct{}
	entered bool
}

func (g *gatedUploadReader) Read(data []byte) (int, error) {
	if !g.entered {
		g.entered = true
		close(g.started)
		<-g.release
	}
	return g.reader.Read(data)
}
func TestStreamingUploadReservationProtectsConcurrentSave(t *testing.T) {
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := uploadRequest(t, "/api/import", nil, []uploadTestFile{{"note.md", []byte("# 上传\n数据正文")}})
	s.freeBytes = func() (int64, error) { return ReserveBytes + request.ContentLength + 2048, nil }
	gate := &gatedUploadReader{reader: request.Body, started: make(chan struct{}), release: make(chan struct{})}
	request.Body = io.NopCloser(gate)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { w := httptest.NewRecorder(); s.importHTTP(w, request); done <- w }()
	select {
	case <-gate.started:
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not start")
	}
	_, saveErr := s.Create(Content{Title: "并发自动保存", Source: strings.Repeat("正文", 2000)}, "", nil)
	var capacity *apiError
	if !errors.As(saveErr, &capacity) || capacity.Status != 507 {
		close(gate.release)
		t.Fatal("concurrent save consumed reserved upload capacity")
	}
	close(gate.release)
	select {
	case result := <-done:
		if result.Code != 200 {
			t.Fatalf("reserved upload failed: %s", result.Body.String())
		}
		var report struct {
			Data importReport `json:"data"`
		}
		_ = json.Unmarshal(result.Body.Bytes(), &report)
		if len(report.Data.Imported) != 1 {
			t.Fatalf("reserved upload did not persist its document: %s", result.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("upload did not complete")
	}
}
