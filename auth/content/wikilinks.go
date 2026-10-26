package content

import (
	"bytes"
	"html"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

const maxWikiLinks = 256
const maxWikiTokenBytes = 2048

type wikiReference struct{ Target, Label string }
type wikiResolution struct{ ID, Reason string }
type wikiResolver func(string) wikiResolution
type wikiNode struct {
	ast.BaseInline
	wikiReference
}

var kindWiki = ast.NewNodeKind("KnowledgeWikiLink")

func (n *wikiNode) Kind() ast.NodeKind            { return kindWiki }
func (n *wikiNode) Dump(source []byte, level int) { ast.DumpHelper(n, source, level, nil, nil) }
func (n *wikiNode) Text(_ []byte) []byte          { return []byte(n.Label) }

type wikiParser struct{ count int }

func (p *wikiParser) Trigger() []byte                         { return []byte{'['} }
func (p *wikiParser) CloseBlock(_ ast.Node, _ parser.Context) {}
func (p *wikiParser) Parse(_ ast.Node, reader text.Reader, context parser.Context) ast.Node {
	if p.count >= maxWikiLinks || context.IsInLinkLabel() {
		return nil
	}
	line, _ := reader.PeekLine()
	if len(line) < 4 || line[0] != '[' || line[1] != '[' {
		return nil
	}
	// Bound every scan even for thousands of incomplete opening brackets.
	if len(line) > maxWikiTokenBytes {
		line = line[:maxWikiTokenBytes]
	}
	end := bytes.Index(line[2:], []byte("]]"))
	if end < 0 {
		return nil
	}
	inner := string(line[2 : 2+end])
	target, label, alias := strings.Cut(inner, "|")
	target = strings.TrimSpace(target)
	label = strings.TrimSpace(label)
	if !alias {
		label = target
	}
	if target == "" || label == "" || utf8.RuneCountInString(target) > 200 || utf8.RuneCountInString(label) > 200 || strings.ContainsAny(inner, "[]\n\r") || strings.IndexFunc(inner, unicode.IsControl) >= 0 {
		return nil
	}
	reader.Advance(end + 4)
	p.count++
	return &wikiNode{wikiReference: wikiReference{target, label}}
}

type wikiRenderer struct{ resolve wikiResolver }

func (r *wikiRenderer) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(kindWiki, r.render)
}
func (r *wikiRenderer) render(w util.BufWriter, _ []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*wikiNode)
	resolution := wikiResolution{Reason: "missing"}
	if r.resolve != nil {
		resolution = r.resolve(n.Target)
	}
	label := html.EscapeString(n.Label)
	target := html.EscapeString(n.Target)
	var output string
	switch {
	case documentID.MatchString(resolution.ID):
		output = `<a class="wiki-link" href="/articles/` + resolution.ID + `/" data-wiki-target="` + target + `">` + label + `</a>`
	case resolution.Reason == "missing":
		href := html.EscapeString("/manage/?new=1&title=" + url.QueryEscape(n.Target))
		output = `<a class="wiki-link wiki-link--missing" href="` + href + `" data-wiki-target="` + target + `" title="待创建文档">` + label + `<span aria-hidden="true"> ↗</span></a>`
	case resolution.Reason == "ambiguous":
		output = `<span class="wiki-link wiki-link--ambiguous" data-wiki-target="` + target + `" title="存在同名文档，请在编辑器选择稳定文档 ID">` + label + `（同名待选择）</span>`
	default:
		output = `<span class="wiki-link wiki-link--unavailable" title="链接索引暂时不可用">` + label + `</span>`
	}
	_, err := w.WriteString(output)
	return ast.WalkSkipChildren, err
}

func knowledgeMarkdown(resolve wikiResolver) goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID(), parser.WithInlineParsers(util.Prioritized(&wikiParser{}, 150))),
		goldmark.WithRendererOptions(renderer.WithNodeRenderers(util.Prioritized(&wikiRenderer{resolve}, 100))),
	)
}

func extractWikiLinks(source string) []wikiReference {
	markdown := knowledgeMarkdown(nil)
	document := markdown.Parser().Parse(text.NewReader([]byte(source)))
	refs := []wikiReference{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if n, ok := node.(*wikiNode); ok && entering {
			refs = append(refs, n.wikiReference)
		}
		return ast.WalkContinue, nil
	})
	return refs
}
