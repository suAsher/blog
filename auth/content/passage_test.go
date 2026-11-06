package content

import (
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func publishPassage(t *testing.T, s *Store, source string) Detail {
	t.Helper()
	d := mustCreate(t, s, input(source))
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestPassageSearchRendersRealAnchorsAndPlainSnippets(t *testing.T) {
	s := testStore(t)
	source := "## 请求诊断\n\n排查 **连接超时** 与 `timeout`，请查看 [[目标|服务日志]]。\n\n### 错误处理\n\n```go\nfmt.Errorf(\"connection refused: %s\", addr)\n```\n\n- 连接超时的重试策略\n\n<script>hidden-secret</script>\n"
	d := publishPassage(t, s, source)
	for _, query := range []string{"连接超时", "connection refused", "服务日志", "ＴＩＭＥＯＵＴ"} {
		result, err := s.SearchPassages(PassageOptions{Query: query})
		if err != nil || result.Total == 0 {
			t.Fatalf("%q: %+v %v", query, result, err)
		}
		for _, hit := range result.Passages {
			if hit.DocumentID != d.ID || hit.Revision != d.PassageRevision || hit.Anchor == "" || !strings.Contains(d.HTML, `id="`+hit.Anchor+`"`) {
				t.Fatalf("search does not point to the rendered snapshot: %+v", hit)
			}
			if strings.ContainsAny(hit.Snippet, "*`") || len(hit.Headings) == 0 || hit.Headings[0].Text != "请求诊断" {
				t.Fatalf("not visible plain text or missing section context: %+v", hit)
			}
		}
	}
	result, err := s.SearchPassages(PassageOptions{Query: "hidden-secret"})
	if err != nil || result.Total != 0 {
		t.Fatal("omitted raw HTML must not create invisible search results")
	}
}

func TestPassageSearchSnapshotIsolationAndStableIDs(t *testing.T) {
	s := testStore(t)
	d := publishPassage(t, s, "## 第一章\n\n保留段落 keyword\n\n保留段落 keyword\n")
	first, err := s.SearchPassages(PassageOptions{Query: "keyword"})
	if err != nil || first.Total != 2 || first.Passages[0].Anchor == first.Passages[1].Anchor {
		t.Fatalf("duplicate paragraphs need unique anchors: %+v %v", first, err)
	}
	original := first.Passages[0]
	d, err = s.Update(d.ID, input("开场段落\n\n## 新章名\n\n保留段落 keyword\n\n保留段落 keyword\n\n未发布 secret-change"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	still, err := s.SearchPassages(PassageOptions{Query: "keyword"})
	if err != nil || still.Passages[0].Revision != original.Revision || still.Passages[0].Anchor != original.Anchor {
		t.Fatal("working edit changed the published index")
	}
	hidden, err := s.SearchPassages(PassageOptions{Query: "secret-change"})
	if err != nil || hidden.Total != 0 {
		t.Fatal("working edit leaked")
	}
	d, err = s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	newer, err := s.SearchPassages(PassageOptions{Query: "keyword"})
	if err != nil || newer.Passages[0].Anchor != original.Anchor || newer.Passages[0].Revision == original.Revision {
		t.Fatal("unrelated insertion must keep block ID and change snapshot revision")
	}
	d, err = s.Update(d.ID, input("改变的段落 keyword"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	d, err = s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := s.SearchPassages(PassageOptions{Query: "keyword"})
	if err != nil || changed.Passages[0].Anchor == original.Anchor || strings.Contains(d.HTML, `id="`+original.Anchor+`"`) {
		t.Fatal("changed text must not silently reuse the old anchor")
	}
	for _, action := range []string{"unpublish", "publish", "trash", "restore", "trash"} {
		d, err = s.Action(d.ID, action, d.Version)
		if err != nil {
			t.Fatal(err)
		}
		r, err := s.SearchPassages(PassageOptions{Query: "keyword"})
		want := 0
		if action == "publish" {
			want = 1
		}
		if err != nil || r.Total != want {
			t.Fatalf("stale snapshot after %s: %+v %v", action, r, err)
		}
	}
	if err := s.Delete(d.ID, d.Version); err != nil {
		t.Fatal(err)
	}
	r, err := s.SearchPassages(PassageOptions{Query: "keyword"})
	if err != nil || r.Total != 0 {
		t.Fatal("deleted snapshot retained")
	}
}

func TestPassageRequestValidationAndPaging(t *testing.T) {
	s := testStore(t)
	publishPassage(t, s, "第一段 needle\n\n第二段 needle\n\n第三段 needle")
	h := &handler{store: s}
	for _, query := range []string{"", "q=", "q=a&q=b", "q=a&view=working", "q=a&limit=0", "q=a&limit=41", "q=a&offset=-1", "q=a&offset=2001", "q=a&pathId=not-an-id", "q=%FF", "q=%00", "q=" + url.QueryEscape(strings.Repeat("字", 257)), "q=" + strings.Repeat("x+", 17), "q=a&tag=" + strings.Repeat("b", 65), "q=a&junk=" + strings.Repeat("x", 4096)} {
		w := httptest.NewRecorder()
		h.passages(w, httptest.NewRequest("GET", "/api/search/passages?"+query, nil))
		if w.Code < 400 || w.Code >= 500 {
			t.Fatalf("invalid query accepted: %q status=%d", query, w.Code)
		}
	}
	w := httptest.NewRecorder()
	h.passages(w, httptest.NewRequest("POST", "/api/search/passages?q=needle", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatal("method must be read only")
	}
	page, err := s.SearchPassages(PassageOptions{Query: "needle", Limit: 1, Offset: 1})
	if err != nil || page.Total != 3 || len(page.Passages) != 1 || !page.HasMore || page.Offset != 1 {
		t.Fatalf("paging: %+v %v", page, err)
	}
	page, err = s.SearchPassages(PassageOptions{Query: "needle", Offset: 100})
	if err != nil || page.Total != 3 || len(page.Passages) != 0 || page.HasMore {
		t.Fatal("out of range page must be empty")
	}
	page, err = s.SearchPassages(PassageOptions{Query: "needle", Tag: "不存在"})
	if err != nil || page.Total != 0 {
		t.Fatal("tag filter ignored")
	}
}

func TestPassageRendererKeepsInteractiveBlocksAndEscaping(t *testing.T) {
	for _, language := range []string{"go", "mermaid", "chart", "recall", "explore"} {
		t.Run(language, func(t *testing.T) {
			source := fmt.Sprintf("```%s\n<script>alert(1)</script>\n```", language)
			rendered, err := renderMarkdown(source, nil)
			if err != nil || !strings.Contains(rendered.HTML, `class="language-`+language+`"`) || !strings.Contains(rendered.HTML, `aria-hidden="true"></span><pre><code`) || strings.Contains(rendered.HTML, "<script>") {
				t.Fatalf("anchor must survive pre replacement and keep safe original code: %s %v", rendered.HTML, err)
			}
		})
	}
}
