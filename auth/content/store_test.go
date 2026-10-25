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

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func input(source string) Content {
	return Content{Title: "真实文档", Description: "文档摘要", Date: "2026-10-25", Tags: []string{"测试标签"}, Category: "测试分类", Source: source}
}
func mustCreate(t *testing.T, s *Store, c Content) Detail {
	t.Helper()
	d, err := s.Create(c, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPublishSnapshotConflictAndPersistence(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("## 原文\n\ncreatePipeline"))
	if d.Version != 1 || d.Status != "draft" {
		t.Fatal("new document must be a draft")
	}
	if _, err := s.Get(d.ID, "published"); err == nil {
		t.Fatal("draft exposed as published")
	}
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if d.Status != "published" || d.HasUnpublishedChanges {
		t.Fatal("publish state")
	}
	changed := input("## 新的草稿\n\nnewbody")
	updated, err := s.Update(d.ID, changed, d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.HasUnpublishedChanges {
		t.Fatal("draft edits need a pending-change indication")
	}
	live, err := s.Get(d.ID, "published")
	if err != nil || !strings.Contains(live.Source, "createPipeline") {
		t.Fatal("working changes replaced the live snapshot")
	}
	if _, err := s.Update(d.ID, changed, d.Version); err == nil {
		t.Fatal("stale version overwrote a newer edit")
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	live, err = reopened.Get(d.ID, "published")
	if err != nil || !strings.Contains(live.Source, "createPipeline") {
		t.Fatal("published snapshot was not durable")
	}
	saved, err := reopened.Get(d.ID, "")
	if err != nil || saved.Source != changed.Source {
		t.Fatal("draft not durable")
	}
	saved, err = reopened.Action(d.ID, "publish", saved.Version)
	if err != nil {
		t.Fatal(err)
	}
	live, _ = reopened.Get(d.ID, "published")
	if live.Source != changed.Source || saved.HasUnpublishedChanges {
		t.Fatal("republish did not update snapshot")
	}
}

func TestTrashRestoreAndDelete(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	if err := s.Delete(d.ID, d.Version); err == nil {
		t.Fatal("must trash before permanent deletion")
	}
	d, _ = s.Action(d.ID, "publish", d.Version)
	d, err := s.Action(d.ID, "trash", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(d.ID, "published"); err == nil {
		t.Fatal("trashed content still published")
	}
	restored, err := s.Action(d.ID, "restore", d.Version)
	if err != nil || restored.Status != "draft" {
		t.Fatal("restore must be a draft")
	}
	if _, err := s.Get(d.ID, "published"); err == nil {
		t.Fatal("restore unexpectedly republished")
	}
	restored, _ = s.Action(d.ID, "trash", restored.Version)
	if err := s.Delete(d.ID, restored.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(d.ID, ""); err == nil {
		t.Fatal("deleted document exists")
	}
}

func TestFullTextSearchAndFacets(t *testing.T) {
	s := testStore(t)
	for _, c := range []Content{input("正文中的uniqueCodeToken 和中文索引"), {Title: "uniqueCodeToken标题", Description: "摘要", Date: "2026-10-25", Tags: []string{"另一个标签"}, Source: "也包含中文索引"}} {
		d := mustCreate(t, s, c)
		if _, err := s.Action(d.ID, "publish", d.Version); err != nil {
			t.Fatal(err)
		}
	}
	mustCreate(t, s, input("uniqueCodeToken 中文索引 draftsecret"))
	result, err := s.List(ListOptions{Status: "published", Query: "uniqueCodeToken 中文索引", Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if result.Total != 2 || len(result.Documents) != 1 || result.Documents[0].Title != "uniqueCodeToken标题" {
		t.Fatal("full-text matching, ranking or pagination incorrect")
	}
	if len(result.Tags) != 2 || result.Stats.Draft != 1 || result.Stats.Published != 2 {
		t.Fatal("facets/stats incorrect")
	}
	filtered, err := s.List(ListOptions{Status: "published", Tag: "测试标签", Limit: 20})
	if err != nil || filtered.Total != 1 {
		t.Fatal("tag filter")
	}
	if len(filtered.Documents[0].Body) > 500 {
		t.Fatal("list returned full body")
	}
	none, _ := s.List(ListOptions{Status: "published", Query: "draftsecret", Limit: 20})
	if none.Total != 0 {
		t.Fatal("draft leaked into search")
	}
}

func TestMarkdownSafetyAndTOC(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("## 中文标题\n\n<script>alert(1)</script>\n\n[恶意](javascript:alert(1))\n\n![配图](https://remote.invalid/a.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```go\nfmt.Println(1)\n```"))
	if strings.Contains(d.HTML, "<script>") || strings.Contains(d.HTML, "javascript:") || strings.Contains(d.HTML, "https://remote.invalid") {
		t.Fatal("unsafe or external image rendered")
	}
	if !strings.Contains(d.HTML, "<table>") || !strings.Contains(d.HTML, "language-go") || len(d.Headings) != 1 || d.Headings[0].Text != "中文标题" || d.Headings[0].Slug == "" {
		t.Fatalf("Markdown features missing: %s", d.HTML)
	}
}

func TestHTTPValidationAndCapacity(t *testing.T) {
	s := testStore(t)
	handler := NewHandler(s)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := call("POST", "/api/documents", `{"title":"","source":"x"}`); w.Code != 400 {
		t.Fatalf("invalid metadata status %d", w.Code)
	}
	if w := call("GET", "/api/documents/../../secret", ""); w.Code == 200 {
		t.Fatal("unsafe document ID")
	}
	if w := call("POST", "/api/preview", `{"source":"## 预览"}`); w.Code != 200 || !strings.Contains(w.Body.String(), "headings") {
		t.Fatal("preview API")
	}
	if w := call("PATCH", "/api/documents", `{}`); w.Code != 405 {
		t.Fatal("unsupported method accepted")
	}
	s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
	if _, err := s.Create(input("x"), "", nil); err == nil {
		t.Fatal("low disk write accepted")
	}
	if w := call("POST", "/api/documents", `{"title":"正文","source":"x"}`); w.Code != 507 {
		t.Fatalf("low capacity status %d", w.Code)
	}
	w := call(http.MethodGet, "/api/documents?status=published", "")
	var response map[string]any
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || response["ok"] != true {
		t.Fatal("envelope")
	}
}

func TestLargeEscapableMarkdownSurvivesPublishingAndRestart(t *testing.T) {
	s := testStore(t)
	source := strings.Repeat("<>&", int(MaxSourceBytes)/3)
	d := mustCreate(t, s, input(source))
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	working, err := restarted.Get(d.ID, "")
	if err != nil || working.Source != source {
		t.Fatalf("valid large working Markdown was not readable after restart: %v", err)
	}
	published, err := restarted.Get(d.ID, "published")
	if err != nil || published.Source != source {
		t.Fatalf("valid large published Markdown was not readable after restart: %v", err)
	}
}

func TestRestartOnlyCleansOwnedOrphanImports(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("persistent document"))
	for _, name := range []string{"import-12345", "import-keep", "unrelated"} {
		if err := os.Mkdir(filepath.Join(s.root, "tmp", name), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.root, "tmp", name, "part"), []byte("temporary"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	restarted, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(s.root, "tmp", "import-12345")); !os.IsNotExist(err) {
		t.Fatal("owned orphan import was not cleaned")
	}
	for _, name := range []string{"import-keep", "unrelated"} {
		if _, err := os.Stat(filepath.Join(s.root, "tmp", name, "part")); err != nil {
			t.Fatal("unrelated temporary data was removed")
		}
	}
	if _, err := restarted.Get(d.ID, ""); err != nil {
		t.Fatal("restart removed a committed document")
	}
}

func TestStreamCapacityReservationBlocksConcurrentWriters(t *testing.T) {
	s := testStore(t)
	s.freeBytes = func() (int64, error) { return ReserveBytes + (8 << 20), nil }
	release, err := s.reserveSpace(8 << 20)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Create(input("a small concurrent draft"), "", nil); err == nil {
		t.Fatal("a concurrent draft consumed upload-reserved space")
	}
	if _, err := s.reserveSpace(1); err == nil {
		t.Fatal("overlapping reservation exceeded free space")
	}
	release()
	release() // Cleanup may be reached through multiple failure paths.
	if _, err := s.Create(input("now safe"), "", nil); err != nil {
		t.Fatal("released upload reservation blocked later saves")
	}
	if s.reservedBytes != 0 {
		t.Fatal("reservation leaked")
	}
}
