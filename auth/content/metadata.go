package content

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Raw fields preserve the distinction between an omitted value, an explicit
// empty value, and null. Do not add UnmarshalJSON to Content: it would consume
// the surrounding version field in the existing anonymous update payload.
type contentRequest struct {
	Content
	Kind     json.RawMessage `json:"kind"`
	Maturity json.RawMessage `json:"maturity"`
	Series   json.RawMessage `json:"series"`
	Related  json.RawMessage `json:"related"`
}

type metadataPresence struct{ kind, maturity, series, related bool }

func (r contentRequest) content() (Content, metadataPresence, error) {
	c := r.Content
	fields := []struct {
		raw    json.RawMessage
		target any
	}{
		{r.Kind, &c.Kind}, {r.Maturity, &c.Maturity},
		{r.Series, &c.Series}, {r.Related, &c.Related},
	}
	for _, field := range fields {
		if len(field.raw) == 0 {
			continue
		}
		if bytes.Equal(bytes.TrimSpace(field.raw), []byte("null")) || json.Unmarshal(field.raw, field.target) != nil {
			return Content{}, metadataPresence{}, bad(400, "文档扩展属性格式无效，清空时请使用空字符串或空列表。")
		}
	}
	return c, metadataPresence{len(r.Kind) > 0, len(r.Maturity) > 0, len(r.Series) > 0, len(r.Related) > 0}, nil
}

func preserveMetadata(c, previous Content, present metadataPresence) Content {
	if !present.kind {
		c.Kind = previous.Kind
	}
	if !present.maturity {
		c.Maturity = previous.Maturity
	}
	if !present.series {
		c.Series = previous.Series
	}
	if !present.related {
		c.Related = append([]string{}, previous.Related...)
	}
	return c
}

func normalizeMetadata(c Content) (Content, error) {
	c.Kind = strings.TrimSpace(c.Kind)
	if c.Kind == "" {
		c.Kind = "article"
	}
	if c.Kind != "article" && c.Kind != "note" {
		return c, bad(400, "文档类型应为文章或随手记。")
	}
	c.Maturity = strings.TrimSpace(c.Maturity)
	if c.Maturity != "" && c.Maturity != "growing" && c.Maturity != "evergreen" {
		return c, bad(400, "成长状态无效。")
	}
	c.Series = strings.TrimSpace(c.Series)
	if utf8.RuneCountInString(c.Series) > 100 || strings.IndexFunc(c.Series, unicode.IsControl) >= 0 {
		return c, bad(400, "系列名称不能超过 100 字或包含控制字符。")
	}
	if len(c.Related) > 32 {
		return c, bad(400, "最多关联 32 篇文档。")
	}
	related := []string{}
	seen := map[string]bool{}
	for _, id := range c.Related {
		if !documentID.MatchString(id) {
			return c, bad(400, "关联文档标识无效。")
		}
		if !seen[id] {
			related = append(related, id)
			seen[id] = true
		}
	}
	c.Related = related
	return c, nil
}

func copyContent(c Content) Content {
	if c.Kind == "" {
		c.Kind = "article"
	}
	c.Tags = append([]string{}, c.Tags...)
	c.Related = append([]string{}, c.Related...)
	return c
}

func sameContent(a, b Content) bool {
	return reflect.DeepEqual(copyContent(a), copyContent(b))
}

func copySummary(value Summary) Summary {
	value.Tags = append([]string{}, value.Tags...)
	value.Related = append([]string{}, value.Related...)
	return value
}
