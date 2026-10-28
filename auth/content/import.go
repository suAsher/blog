package content

import (
	"bytes"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.yaml.in/yaml/v3"
)

type importSkip struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}
type unresolvedImage struct {
	Document string `json:"document"`
	Path     string `json:"path"`
}
type importReport struct {
	ID          string            `json:"id"`
	CreatedAt   string            `json:"createdAt"`
	Updated     []Summary         `json:"updated"`
	Outcomes    []importOutcome   `json:"outcomes"`
	Fingerprint string            `json:"fingerprint,omitempty"`
	Imported    []Summary         `json:"imported"`
	Skipped     []importSkip      `json:"skipped"`
	Unresolved  []unresolvedImage `json:"unresolvedImages"`
	Warnings    []string          `json:"warnings"`
	Quota       Quota             `json:"quota"`
}

func parseImported(name string, data []byte) (Content, error) {
	if int64(len(data)) > MaxSourceBytes {
		return Content{}, bad(413, "单篇文档不能超过 2 MB。")
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return Content{}, bad(400, "文档必须是 UTF-8 编码的 Markdown 或 TXT。")
	}
	source := strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n")
	content := Content{Date: time.Now().UTC().Format("2006-01-02"), Tags: []string{}}
	if strings.HasPrefix(source, "---\n") && strings.ToLower(path.Ext(name)) != ".txt" {
		end := strings.Index(source[4:], "\n---\n")
		if end < 0 && strings.HasSuffix(source, "\n---") {
			end = len(source) - 8
		}
		if end < 0 || end > 64<<10 {
			return Content{}, bad(400, "Markdown 元数据没有正确结束或超过大小限制。")
		}
		metadata := source[4 : 4+end]
		var front struct {
			Title       string    `yaml:"title"`
			Description string    `yaml:"description"`
			Summary     string    `yaml:"summary"`
			Date        string    `yaml:"date"`
			Tags        yaml.Node `yaml:"tags"`
			Category    string    `yaml:"category"`
			Cover       string    `yaml:"cover"`
			Kind        yaml.Node `yaml:"kind"`
			Maturity    yaml.Node `yaml:"maturity"`
			Series      yaml.Node `yaml:"series"`
			Related     yaml.Node `yaml:"related"`
		}
		if yaml.Unmarshal([]byte(metadata), &front) != nil {
			return Content{}, bad(400, "Markdown 元数据格式无效。")
		}
		content.Title, content.Description, content.Category, content.Cover = front.Title, front.Description, front.Category, front.Cover
		for _, field := range []struct {
			node   yaml.Node
			target any
		}{
			{front.Kind, &content.Kind}, {front.Maturity, &content.Maturity},
			{front.Series, &content.Series}, {front.Related, &content.Related},
		} {
			if field.node.Kind == 0 {
				continue
			}
			if field.node.Tag == "!!null" || field.node.Decode(field.target) != nil {
				return Content{}, bad(400, "文档扩展属性格式无效。")
			}
		}
		if content.Description == "" {
			content.Description = front.Summary
		}
		if front.Date != "" {
			if len(front.Date) >= 10 {
				content.Date = front.Date[:10]
			} else {
				content.Date = front.Date
			}
		}
		if front.Tags.Kind == yaml.ScalarNode {
			content.Tags = strings.Split(front.Tags.Value, ",")
		} else if front.Tags.Kind != 0 && front.Tags.Decode(&content.Tags) != nil {
			return Content{}, bad(400, "标签应为文本列表。")
		}
		start := 4 + end + 5
		if start > len(source) {
			start = len(source)
		}
		source = source[start:]
	}
	if strings.TrimSpace(source) == "" {
		return Content{}, bad(400, "空文档已跳过。")
	}
	if err := validateSource(source); err != nil {
		return Content{}, err
	}
	content.Source = source
	if content.Title == "" {
		for _, line := range strings.Split(source, "\n") {
			if strings.HasPrefix(line, "# ") {
				content.Title = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line[2:]), " #"))
				break
			}
		}
	}
	if content.Title == "" {
		content.Title = strings.TrimSuffix(path.Base(name), path.Ext(name))
	}
	return content, nil
}

func markdownImages(source string) []string {
	reader := text.NewReader([]byte(source))
	document := knowledgeMarkdown(nil).Parser().Parse(reader)
	result := []string{}
	seen := map[string]bool{}
	_ = ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if image, ok := node.(*ast.Image); ok && entering {
			value := string(image.Destination)
			if !seen[value] {
				result = append(result, value)
				seen[value] = true
			}
		}
		return ast.WalkContinue, nil
	})
	return result
}

func imageRelativePath(document, destination string) (string, bool) {
	u, err := url.Parse(escapeInvalidPercents(destination))
	if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(destination, "//") || strings.ContainsAny(u.Path, "\\\x00\r\n") {
		return "", false
	}
	imagePath := u.Path
	if imagePath == "" || strings.HasPrefix(imagePath, "/") {
		return "", false
	}
	resolved := path.Clean(path.Join(path.Dir(document), imagePath))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return "", false
	}
	return resolved, true
}
