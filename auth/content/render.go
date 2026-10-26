package content

import (
	"bytes"
	"html"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

type Preview struct {
	HTML           string    `json:"html"`
	Headings       []Heading `json:"headings"`
	ReadingMinutes int       `json:"readingMinutes"`
}

func readingMinutes(source string) int {
	count := utf8.RuneCountInString(strings.Join(strings.Fields(source), ""))
	minutes := (count + 349) / 350
	if minutes < 1 {
		minutes = 1
	}
	return minutes
}
func safeLink(destination string) bool {
	decoded := html.UnescapeString(destination)
	if value, err := url.PathUnescape(decoded); err == nil {
		decoded = value
	}
	if strings.HasPrefix(decoded, "//") || strings.Contains(decoded, "\\") || strings.IndexFunc(decoded, func(r rune) bool { return unicode.IsControl(r) }) >= 0 {
		return false
	}
	parsed, err := url.Parse(decoded)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	return scheme == "" || scheme == "https" || scheme == "http" || scheme == "mailto"
}

func renderMarkdown(source string, aliases map[string]string) (Preview, error) {
	return renderMarkdownResolved(source, aliases, nil)
}

func renderMarkdownResolved(source string, aliases map[string]string, resolve wikiResolver) (Preview, error) {
	if err := validateSource(source); err != nil {
		return Preview{}, err
	}
	renderer := knowledgeMarkdown(resolve)
	data := []byte(source)
	document := renderer.Parser().Parse(text.NewReader(data))
	headings := []Heading{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch current := node.(type) {
		case *ast.Image:
			destination := string(current.Destination)
			if mapped, ok := aliases[destination]; ok {
				destination = mapped
			}
			if !assetURL.MatchString(destination) && !(strings.HasPrefix(destination, "/images/") && safeLink(destination) && !strings.Contains(destination, "..")) {
				destination = ""
			}
			current.Destination = []byte(destination)
		case *ast.Link:
			if !safeLink(string(current.Destination)) {
				current.Destination = []byte("#")
			}
		case *ast.AutoLink:
			// Goldmark's renderer additionally rejects dangerous schemes by default.
		case *ast.Heading:
			if current.Level == 2 || current.Level == 3 {
				value, _ := current.AttributeString("id")
				slug := ""
				if raw, ok := value.([]byte); ok {
					slug = string(raw)
				}
				headings = append(headings, Heading{Depth: current.Level, Slug: slug, Text: string(current.Text(data))})
			}
		}
		return ast.WalkContinue, nil
	})
	var output bytes.Buffer
	if err := renderer.Renderer().Render(&output, data, document); err != nil {
		return Preview{}, bad(500, "正文暂时无法渲染，请检查 Markdown。")
	}
	return Preview{HTML: output.String(), Headings: headings, ReadingMinutes: readingMinutes(source)}, nil
}
