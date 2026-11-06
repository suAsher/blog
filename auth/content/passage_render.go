package content

import (
	"crypto/sha256"
	"encoding/hex"
	"html"
	"strconv"
	"strings"

	"github.com/yuin/goldmark/ast"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

const maxPassageBlocks = 4096

type passageBlock struct {
	anchor, kind, text, indexed string
	headings                    []Heading
}

type passageIndex struct {
	revision  string
	blocks    []passageBlock
	truncated bool
}

func passageRevision(source string) string {
	digest := sha256.Sum256([]byte(source))
	return hex.EncodeToString(digest[:])
}

// Only generated anchors enter this renderer; source HTML still follows the
// default unsafe=false renderer. A sibling survives Mermaid/chart replacement
// of a fenced <pre>, and adds no text to annotation offset projections.
type passageAnchor struct {
	ast.BaseBlock
	id string
}

var kindPassageAnchor = ast.NewNodeKind("KnowledgePassageAnchor")

func (n *passageAnchor) Kind() ast.NodeKind { return kindPassageAnchor }
func (n *passageAnchor) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, nil, nil)
}

type passageRenderer struct{}

func (*passageRenderer) RegisterFuncs(register renderer.NodeRendererFuncRegisterer) {
	register.Register(kindPassageAnchor, renderPassageAnchor)
}

func renderPassageAnchor(w util.BufWriter, _ []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	_, err := w.WriteString(`<span id="` + node.(*passageAnchor).id + `" class="passage-anchor" aria-hidden="true"></span>`)
	return ast.WalkSkipChildren, err
}

// Text leaves reproduce visible inline labels, not Markdown delimiters, link
// destinations, image metadata, or omitted raw HTML. Code is handled separately.
func passageInlineText(node ast.Node, source []byte) string {
	var out strings.Builder
	_ = ast.Walk(node, func(current ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch value := current.(type) {
		case *ast.RawHTML, *ast.Image:
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			out.WriteString(html.UnescapeString(string(util.UnescapePunctuations(value.Value(source)))))
			if value.SoftLineBreak() || value.HardLineBreak() {
				out.WriteByte(' ')
			}
		case *ast.String:
			out.WriteString(html.UnescapeString(string(value.Value)))
		case *ast.AutoLink:
			out.Write(value.Label(source))
		case *wikiNode:
			out.WriteString(value.Label)
		case *extast.TableCell:
			out.WriteByte(' ')
		}
		return ast.WalkContinue, nil
	})
	return strings.Join(strings.Fields(out.String()), " ")
}

func passageNodeText(node ast.Node, source []byte) (string, string) {
	switch node.Kind() {
	case ast.KindParagraph:
		return "paragraph", passageInlineText(node, source)
	case ast.KindTextBlock:
		return "list", passageInlineText(node, source)
	case ast.KindCodeBlock, ast.KindFencedCodeBlock:
		return "code", strings.TrimSpace(string(node.Lines().Value(source)))
	case extast.KindTable:
		return "table", passageInlineText(node, source)
	default:
		return "", ""
	}
}

func passageHeading(node *ast.Heading, source []byte) Heading {
	value, _ := node.AttributeString("id")
	id, _ := value.([]byte)
	return Heading{Depth: node.Level, Slug: string(id), Text: passageInlineText(node, source)}
}

func passageContextHeading(heading Heading) Heading {
	count := 0
	for at := range heading.Text {
		if count == 160 {
			heading.Text = heading.Text[:at]
			break
		}
		count++
	}
	// Do not invent a truncated destination. The actual long heading ID remains
	// in rendered HTML; search breadcrumbs can show its bounded label only.
	if len(heading.Slug) > 512 {
		heading.Slug = ""
	}
	return heading
}

// The same AST walk supplies the index and rendered IDs. Unrelated insertions
// keep IDs stable; identical duplicate blocks receive deterministic ordinals.
// Editing a block changes its ID. Clients compare revision and detect missing
// anchors, rather than pretending an old result still points to identical text.
func passageBlocks(document ast.Node, source []byte, decorate bool) passageIndex {
	index := passageIndex{revision: passageRevision(string(source)), blocks: []passageBlock{}}
	reserved := map[string]bool{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if heading, ok := node.(*ast.Heading); entering && ok {
			reserved[passageHeading(heading, source).Slug] = true
		}
		return ast.WalkContinue, nil
	})
	type anchorTarget struct {
		node ast.Node
		id   string
	}
	targets := []anchorTarget{}
	counts := map[string]int{}
	headings := []Heading{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if heading, ok := node.(*ast.Heading); ok {
			for len(headings) > 0 && headings[len(headings)-1].Depth >= heading.Level {
				headings = headings[:len(headings)-1]
			}
			headings = append(headings, passageContextHeading(passageHeading(heading, source)))
			return ast.WalkSkipChildren, nil
		}
		kind, body := passageNodeText(node, source)
		if kind == "" || body == "" {
			return ast.WalkContinue, nil
		}
		if len(index.blocks) == maxPassageBlocks {
			index.truncated = true
			return ast.WalkStop, nil
		}
		digest := sha256.Sum256([]byte(kind + "\x00" + body))
		base := "passage-" + hex.EncodeToString(digest[:10])
		counts[base]++
		id := base + "-" + strconv.Itoa(counts[base])
		for reserved[id] {
			id += "-a"
		}
		reserved[id] = true
		index.blocks = append(index.blocks, passageBlock{
			anchor: id, kind: kind, text: body, indexed: normalized(body),
			headings: append([]Heading{}, headings...),
		})
		if decorate {
			targets = append(targets, anchorTarget{node, id})
		}
		return ast.WalkSkipChildren, nil
	})
	for _, target := range targets {
		if target.node.Kind() == ast.KindParagraph {
			target.node.SetAttributeString("id", []byte(target.id))
		} else {
			target.node.Parent().InsertBefore(target.node.Parent(), target.node, &passageAnchor{id: target.id})
		}
	}
	return index
}

func buildPassageIndex(source string) passageIndex {
	data := []byte(source)
	document := knowledgeMarkdown(nil).Parser().Parse(text.NewReader(data))
	return passageBlocks(document, data, false)
}
