package content

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestPassageLearningPathsIncludePublishedPracticeOnly(t *testing.T) {
	s := testStore(t)
	reading := publishPassage(t, s, "阅读材料 route-token")
	practice := publishPassage(t, s, "实践记录 route-token")
	draft := mustCreate(t, s, input("未发布记录 route-token"))
	publishPassage(t, s, "路线外 route-token")
	path, err := s.writeLearning("", learningRequest{
		Title: "系统阅读", Accent: "mint",
		Chapters: []learningChapterRequest{{
			ID: "chapter-1", Title: "第一章", DocumentIDs: []string{reading.ID},
			PracticeDocumentIDs: &[]string{practice.ID, draft.ID},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.SearchPassages(PassageOptions{Query: "route-token", PathID: path.ID})
	if err != nil || result.Total != 2 {
		t.Fatalf("route context or published boundary failed: %+v %v", result, err)
	}
	for _, hit := range result.Passages {
		if len(hit.Paths) != 1 || hit.Paths[0].ChapterTitle != "第一章" || hit.Paths[0].PathID != path.ID || hit.DocumentID == draft.ID {
			t.Fatalf("unexpected route metadata: %+v", hit)
		}
	}
	result.Passages[0].Tags[0] = "caller mutated"
	result.Passages[0].Paths[0].PathTitle = "caller mutated"
	second, err := s.SearchPassages(PassageOptions{Query: "route-token", PathID: path.ID})
	if err != nil || second.Passages[0].Tags[0] == "caller mutated" || second.Passages[0].Paths[0].PathTitle == "caller mutated" {
		t.Fatal("caller modified derived state")
	}
	if _, err := s.SearchPassages(PassageOptions{Query: "route-token", PathID: strings.Repeat("a", 32)}); err == nil {
		t.Fatal("missing route cannot silently search everything")
	}
}

func TestPassageCacheIsContentAddressedAndBounded(t *testing.T) {
	a, b := "alpha paragraph", "bravo paragraph"
	cache := newPassageCache(passageIndexBytes(buildPassageIndex(a)) + 8)
	first := cache.get(a)
	cache.get(a)
	if len(cache.entries) != 1 {
		t.Fatal("identical snapshot should share one entry")
	}
	cache.get(b)
	if cache.bytes > cache.limit || len(cache.entries) != 1 || cache.entries[passageRevision(a)] != nil {
		t.Fatal("LRU memory accounting did not evict the old entry")
	}
	if first.blocks[0].text != a {
		t.Fatal("eviction mutated a reader's index")
	}
	tiny := newPassageCache(1)
	if got := tiny.get(a); len(got.blocks) != 1 || len(tiny.entries) != 0 || tiny.bytes != 0 {
		t.Fatal("large entries must bypass the cache, not fail searching")
	}
}

func TestPassageBudgetsAreHonestAndSnapshotsRemainReadable(t *testing.T) {
	s := testStore(t)
	var source strings.Builder
	for i := 0; i < maxPassageResults+2; i++ {
		fmt.Fprintf(&source, "search-budget 段落 %d\n\n", i)
	}
	d := publishPassage(t, s, source.String())
	result, err := s.SearchPassages(PassageOptions{Query: "search-budget", Limit: 40})
	if err != nil || !result.Truncated || result.Message == "" || result.Total != maxPassageResults || len(result.Passages) != 40 {
		t.Fatalf("result budget was not surfaced: %+v %v", result, err)
	}
	if _, err := s.Get(d.ID, "published"); err != nil {
		t.Fatal("search budget must not restrict ordinary reading")
	}
	blocks := buildPassageIndex(strings.Repeat("bounded block\n\n", maxPassageBlocks+1))
	if !blocks.truncated || len(blocks.blocks) != maxPassageBlocks {
		t.Fatal("per-document AST block budget not surfaced")
	}
}

func TestPassageMetadataAndOutputBudget(t *testing.T) {
	source := "## " + strings.Repeat("超长标题", 2000) + "\n\n命中段落 body-token\n"
	index := buildPassageIndex(source)
	if len(index.blocks) != 1 || len([]rune(index.blocks[0].headings[0].Text)) > 160 || len(index.blocks[0].headings[0].Slug) > 512 {
		t.Fatal("search context must not repeat an unbounded Markdown heading")
	}
	paths := map[string][]PassagePath{"document": make([]PassagePath, 50)}
	result := passagePage([]passageMatch{{document: Summary{ID: "document"}, block: passageBlock{text: "body-token", indexed: "body-token"}}}, paths, []string{"body-token"}, PassageOptions{Limit: 12}, false)
	if result.Passages[0].PathCount != 50 || len(result.Passages[0].Paths) != maxPassagePaths {
		t.Fatal("route metadata budget should preserve the total count")
	}
}

func TestPassageCacheCannotHideCorruption(t *testing.T) {
	for _, kind := range []string{"symlink", "directory-symlink", "corrupt", "missing-directory", "corrupt-route"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			d := publishPassage(t, s, "safe needle")
			if _, err := s.SearchPassages(PassageOptions{Query: "needle"}); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(s.root, "documents", d.ID+".json")
			switch kind {
			case "symlink":
				target := filepath.Join(s.root, "fixture.json")
				data, _ := os.ReadFile(name)
				os.WriteFile(target, data, 0600)
				os.Remove(name)
				os.Symlink(target, name)
			case "corrupt":
				os.WriteFile(name, []byte("not json"), 0600)
			case "missing-directory":
				os.Rename(filepath.Dir(name), filepath.Join(s.root, "moved-documents"))
			case "directory-symlink":
				target := filepath.Join(s.root, "moved-documents")
				os.Rename(filepath.Dir(name), target)
				os.Symlink(target, filepath.Dir(name))
			case "corrupt-route":
				os.WriteFile(filepath.Join(s.root, "state", "learning.json"), []byte("not json"), 0600)
			}
			w := httptest.NewRecorder()
			(&handler{store: s}).passages(w, httptest.NewRequest("GET", "/api/search/passages?q=needle", nil))
			if w.Code != 500 {
				t.Fatalf("warm cache masked %s: %d", kind, w.Code)
			}
		})
	}
}

func TestPassageConcurrentQueriesAndWorkingEdits(t *testing.T) {
	s := testStore(t)
	d := publishPassage(t, s, "race-token published snapshot")
	var group sync.WaitGroup
	for i := 0; i < 4; i++ {
		group.Go(func() {
			for j := 0; j < 12; j++ {
				result, err := s.SearchPassages(PassageOptions{Query: "race-token"})
				if err != nil || result.Total != 1 || result.Passages[0].Snippet != "race-token published snapshot" {
					t.Errorf("concurrent snapshot leak: %+v %v", result, err)
				}
			}
		})
	}
	for i := 0; i < 8; i++ {
		var err error
		d, err = s.Update(d.ID, input(fmt.Sprintf("draft edit %d", i)), d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	group.Wait()
}

func TestPassageScanBudgetsRejectFurtherWork(t *testing.T) {
	budget := passageScanBudget{}
	if !budget.record(maxPassageReadBytes) || budget.record(1) {
		t.Fatal("record read budget ignored")
	}
	budget = passageScanBudget{documents: maxPassageDocuments}
	if budget.record(1) {
		t.Fatal("document scan budget ignored")
	}
	if !budget.source(maxPassageScanBytes) || budget.source(1) {
		t.Fatal("source parse budget ignored")
	}
	if !budget.index(maxPassageScanBlocks) || budget.index(1) {
		t.Fatal("block scan budget ignored")
	}
}

func TestPassageVisibleInlineAndTableText(t *testing.T) {
	source := "line **strong** &amp; `inline` [label](https://example.test/private-target) ![hidden-image](/images/a.svg)\nnext line  \nhard break\n\n| name | state |\n| --- | --- |\n| service | connection-refused |\n\n    indented-code\n\n<https://example.test/visible-link>\n"
	index := buildPassageIndex(source)
	if len(index.blocks) != 4 || index.blocks[0].text != "line strong & inline label next line hard break" || index.blocks[1].kind != "table" || !strings.Contains(index.blocks[1].text, "connection-refused") || index.blocks[2].kind != "code" || !strings.Contains(index.blocks[3].text, "visible-link") {
		t.Fatalf("visible text does not match rendered blocks: %+v", index.blocks)
	}
	if got := passageContextHeading(Heading{Text: "visible", Slug: strings.Repeat("h", 513)}); got.Slug != "" {
		t.Fatal("oversized heading slug must be omitted, not truncated to a false link")
	}
	first := buildPassageIndex("anchor-collision").blocks[0]
	collision := "# " + first.anchor + "\n\nanchor-collision"
	rendered, err := renderMarkdown(collision, nil)
	if err != nil || strings.Count(rendered.HTML, `id="`+first.anchor+`"`) != 1 || !strings.Contains(rendered.HTML, `id="`+first.anchor+`-a"`) {
		t.Fatal("generated IDs must not collide with existing heading anchors")
	}
}

func TestPassageHTTPSuccessAndMalformedQueries(t *testing.T) {
	s := testStore(t)
	publishPassage(t, s, "needle <tag> & more")
	h := &handler{store: s}
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		h.passages(w, httptest.NewRequest(method, "/api/search/passages?q=needle&limit=1&offset=0&tag="+"%E6%B5%8B%E8%AF%95%E6%A0%87%E7%AD%BE", nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) || !strings.Contains(w.Body.String(), `"total":1`) {
			t.Fatalf("valid %s failed: %d %s", method, w.Code, w.Body.String())
		}
	}
	for _, query := range []string{"q=%QQ", "q=needle&offset=invalid", "q=needle&limit=invalid"} {
		w := httptest.NewRecorder()
		h.passages(w, httptest.NewRequest("GET", "/api/search/passages?"+query, nil))
		if w.Code != 400 {
			t.Fatalf("bad query was accepted: %s", query)
		}
	}
}
