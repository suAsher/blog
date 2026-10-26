package content

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func publishWiki(t *testing.T, s *Store, title, source string) Detail {
	t.Helper()
	c := input(source)
	c.Title = title
	d := mustCreate(t, s, c)
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestWikiUnpublishedIntermediateNamesNeverEnterPublishedAliases(t *testing.T) {
	s := testStore(t)
	target := publishWiki(t, s, "旧发布标题", "body")
	c := input("body")
	c.Title = "私有中间名"
	target, err := s.Update(target.ID, c, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	c.Title = "新发布标题"
	target, err = s.Update(target.ID, c, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	target, err = s.Action(target.ID, "publish", target.Version)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s)
	for _, query := range []string{"私有中间名", "旧发布标题"} {
		pub := metadataResult(t, apiCall(h, "GET", "/api/link-targets?q="+url.QueryEscape(query), nil))
		count := len(pub["documents"].([]any))
		if query == "私有中间名" && count != 0 || query == "旧发布标题" && count != 1 {
			t.Fatal("published aliases leaked draft history", pub)
		}
	}
	work := metadataResult(t, apiCall(h, "GET", "/api/link-targets?view=working&q="+url.QueryEscape("私有中间名"), nil))
	if len(work["documents"].([]any)) != 1 {
		t.Fatal("author lost working title history")
	}
	ref := publishWiki(t, s, "引用", "[[旧发布标题]] [[私有中间名]]")
	links := metadataResult(t, apiCall(h, "GET", "/api/documents/"+ref.ID+"/links", nil))
	if len(links["outgoing"].([]any)) != 1 || len(links["unresolved"].([]any)) != 1 {
		t.Fatal("published resolver used working aliases", links)
	}
}

func TestWikiAliasCollisionsAndTitleHistoryBounds(t *testing.T) {
	s := testStore(t)
	a := publishWiki(t, s, "历史重名", "one")
	b := publishWiki(t, s, "历史重名", "two")
	for _, d := range []Detail{a, b} {
		c := input("body")
		c.Title = "新标题" + d.ID
		updated, err := s.Update(d.ID, c, d.Version)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Action(d.ID, "publish", updated.Version); err != nil {
			t.Fatal(err)
		}
	}
	ref := publishWiki(t, s, "引用", "[[历史重名]]")
	links := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/documents/"+ref.ID+"/links", nil))
	if links["unresolved"].([]any)[0].(map[string]any)["reason"] != "ambiguous" {
		t.Fatal("alias collision chose first")
	}
	d := mustCreate(t, s, input("body"))
	for i := 0; i < 40; i++ {
		c := input("body")
		c.Title = fmt.Sprintf("标题%02d", i)
		var err error
		d, err = s.Update(d.ID, c, d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	s.mu.RLock()
	record, err := s.loadLocked(d.ID)
	s.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(record.WorkingTitleAliases) != 32 || len(record.PublishedTitleAliases) != 0 || record.Aliases != nil {
		t.Fatal("histories unbounded or mixed with image aliases")
	}
	previous := []string{}
	for i := 0; i < 40; i++ {
		previous = rememberTitle(previous, fmt.Sprintf("%02d", i)+strings.Repeat("中", 190))
	}
	if titleAliasBytes(previous) > 8<<10 || len(previous) > 32 {
		t.Fatal("UTF8 history byte budget exceeded")
	}
}

func TestWikiLimitsLiteralFallbackPreviewAndMalformedInputs(t *testing.T) {
	s := testStore(t)
	target := mustCreate(t, s, input("working body"))
	source := strings.Repeat("[[真实文档]] ", 300)
	refs := extractWikiLinks(source)
	if len(refs) != 256 {
		t.Fatal("wiki AST budget not enforced")
	}
	preview := metadataResult(t, apiCall(NewHandler(s), "POST", "/api/preview", map[string]any{"source": "[[真实文档|作者预览]]", "documentId": target.ID}))
	if !strings.Contains(preview["html"].(string), "/articles/"+target.ID+"/") {
		t.Fatal("working preview cannot resolve draft")
	}
	for _, source := range []string{"[[ ]]", "[[x| ]]", "[[x\ny]]", "[[" + strings.Repeat("x", 201) + "]]", "\\[[escaped]]", "[[outer [[inner]]]]"} {
		refs := extractWikiLinks(source)
		if len(refs) > 0 {
			t.Fatalf("malformed/escaped wiki parsed: %q %#v", source, refs)
		}
	}
}

func TestWikiExternalRestoreInvalidatesTitleIndex(t *testing.T) {
	s := testStore(t)
	target := publishWiki(t, s, "旧标题", "body")
	ref := publishWiki(t, s, "引用", "[[旧标题]]")
	live, _ := s.Get(ref.ID, "published")
	if !strings.Contains(live.HTML, target.ID) {
		t.Fatal("initial resolution")
	}
	name := filepath.Join(s.root, "documents", target.ID+".json")
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	_ = json.Unmarshal(data, &record)
	record["working"].(map[string]any)["title"] = "新标题"
	record["published"].(map[string]any)["title"] = "新标题"
	data, _ = json.Marshal(record)
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	live, err = s.Get(ref.ID, "published")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(live.HTML, "/articles/"+target.ID+"/") || !strings.Contains(live.HTML, "wiki-link--missing") {
		t.Fatal("external restore left stale derived index", live.HTML)
	}
}

func TestWikiRenderingExcludesCodeAndNestedLinks(t *testing.T) {
	s := testStore(t)
	target := publishWiki(t, s, "目标", "body")
	source := "[[目标|别名]] 与 [[" + target.ID + "|稳定链接]]\n\n`[[代码]]`\n\n```mermaid\n[[围栏]]\n```\n\n[普通 [[嵌套]] 链接](https://example.test)\n\n[[新文档]]"
	d := publishWiki(t, s, "引用文章", source)
	live, err := s.Get(d.ID, "published")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(live.HTML, `href="/articles/`+target.ID+`/"`) != 2 {
		t.Fatal("resolved wiki links missing", live.HTML)
	}
	if !strings.Contains(live.HTML, `/manage/?new=1&amp;title=`+url.QueryEscape("新文档")) {
		t.Fatal("missing target lacks safe creation link", live.HTML)
	}
	if strings.Contains(live.HTML, `data-wiki-target="代码"`) || strings.Contains(live.HTML, `data-wiki-target="围栏"`) || strings.Contains(live.HTML, `data-wiki-target="嵌套"`) {
		t.Fatal("code/nested link parsed as wiki", live.HTML)
	}
	links := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/documents/"+d.ID+"/links", nil))
	if len(links["outgoing"].([]any)) != 1 || len(links["unresolved"].([]any)) != 1 {
		t.Fatal("extraction differs from rendered AST", links)
	}
}

func TestWikiAliasesAndLabelsEscapeHTML(t *testing.T) {
	s := testStore(t)
	target := publishWiki(t, s, "安全目标", "body")
	d := publishWiki(t, s, "安全引用", "[[安全目标|<img src=x onerror=alert(1)>]] [[不存在\" onclick=\"alert(1)|<script>alert(1)</script>]]")
	live, err := s.Get(d.ID, "published")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(live.HTML, "<img src=x") || strings.Contains(live.HTML, "<script>") || strings.Contains(live.HTML, ` onclick="alert`) {
		t.Fatal("wiki XSS", live.HTML)
	}
	if !strings.Contains(live.HTML, "&lt;img") || !strings.Contains(live.HTML, target.ID) {
		t.Fatal("wiki escaped labels missing", live.HTML)
	}
}

func TestWikiPublishedHistoryIsolationAndStableIDs(t *testing.T) {
	s := testStore(t)
	target := publishWiki(t, s, "原标题", "body")
	ref := publishWiki(t, s, "引用", "[[原标题]] [["+target.ID+"|稳定]]")
	c := input("private working content")
	c.Title = "尚未发布标题"
	updated, err := s.Update(target.ID, c, target.Version)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s)
	pub := metadataResult(t, apiCall(h, "GET", "/api/graph", nil))
	encoded, _ := json.Marshal(pub)
	if strings.Contains(string(encoded), "尚未发布") {
		t.Fatal("working rename leaked through graph")
	}
	live, _ := s.Get(ref.ID, "published")
	if strings.Count(live.HTML, "/articles/"+target.ID+"/") != 2 {
		t.Fatal("working rename broke published links")
	}
	target, err = s.Action(target.ID, "publish", updated.Version)
	if err != nil {
		t.Fatal(err)
	}
	live, _ = s.Get(ref.ID, "published")
	if strings.Count(live.HTML, "/articles/"+target.ID+"/") != 2 {
		t.Fatal("published title alias did not preserve old link")
	}
	restarted, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	live, err = restarted.Get(ref.ID, "published")
	if err != nil || strings.Count(live.HTML, "/articles/"+target.ID+"/") != 2 {
		t.Fatal("title histories not durable")
	}
	back := metadataResult(t, apiCall(NewHandler(restarted), "GET", "/api/documents/"+target.ID+"/links", nil))
	if len(back["backlinks"].([]any)) != 1 {
		t.Fatal("backlinks lost after restart", back)
	}
}

func TestWikiDuplicateTitlesAreAmbiguousAndExactTitleWinsAliases(t *testing.T) {
	s := testStore(t)
	a := publishWiki(t, s, "同名", "a")
	b := publishWiki(t, s, "同名", "b")
	ref := publishWiki(t, s, "引用", "[[同名]]")
	h := NewHandler(s)
	links := metadataResult(t, apiCall(h, "GET", "/api/documents/"+ref.ID+"/links", nil))
	u := links["unresolved"].([]any)
	if len(u) != 1 || u[0].(map[string]any)["reason"] != "ambiguous" || len(links["outgoing"].([]any)) != 0 {
		t.Fatal("duplicate title silently picked first", links)
	}
	c := input("renamed")
	c.Title = "新名"
	a, err := s.Update(a.ID, c, a.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Action(a.ID, "publish", a.Version)
	if err != nil {
		t.Fatal(err)
	}
	links = metadataResult(t, apiCall(h, "GET", "/api/documents/"+ref.ID+"/links", nil))
	if links["outgoing"].([]any)[0].(map[string]any)["id"] != b.ID {
		t.Fatal("exact current title did not outrank historical alias")
	}
}
