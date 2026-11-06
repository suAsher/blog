package content

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type PassageOptions struct {
	Query, Tag, PathID string
	Limit, Offset      int
}

type PassagePath struct {
	PathID       string `json:"pathId"`
	PathTitle    string `json:"pathTitle"`
	ChapterID    string `json:"chapterId"`
	ChapterTitle string `json:"chapterTitle"`
}

type PassageResult struct {
	DocumentID  string        `json:"documentId"`
	Title       string        `json:"title"`
	Tags        []string      `json:"tags"`
	Category    string        `json:"category"`
	PublishedAt string        `json:"publishedAt"`
	Revision    string        `json:"revision"`
	Anchor      string        `json:"anchor"`
	Kind        string        `json:"kind"`
	Snippet     string        `json:"snippet"`
	Headings    []Heading     `json:"headings"`
	Paths       []PassagePath `json:"paths"`
	PathCount   int           `json:"pathCount"`
}

type PassageData struct {
	Passages  []PassageResult `json:"passages"`
	Total     int             `json:"total"`
	Limit     int             `json:"limit"`
	Offset    int             `json:"offset"`
	HasMore   bool            `json:"hasMore"`
	Truncated bool            `json:"truncated"`
	Message   string          `json:"message"`
}

func validPassageOptions(options PassageOptions) error {
	if !utf8.ValidString(options.Query) || len(strings.Fields(options.Query)) > 16 ||
		strings.TrimSpace(options.Query) == "" || utf8.RuneCountInString(options.Query) > 256 ||
		strings.IndexFunc(options.Query, unicode.IsControl) >= 0 {
		return bad(400, "请输入 1 至 256 字的搜索词，最多 16 个空格分隔的关键词。")
	}
	if !utf8.ValidString(options.Tag) || utf8.RuneCountInString(options.Tag) > 64 || strings.IndexFunc(options.Tag, unicode.IsControl) >= 0 {
		return bad(400, "标签格式无效或超过 64 字。")
	}
	if options.PathID != "" && !documentID.MatchString(options.PathID) {
		return bad(400, "路线标识无效。")
	}
	if options.Limit < 0 || options.Limit > 40 || options.Offset < 0 || options.Offset > maxPassageResults {
		return bad(400, "分页数量应为 1 至 40，起点应为 0 至 2000。")
	}
	return nil
}

func passageRequest(r *http.Request) (PassageOptions, error) {
	if len(r.URL.EscapedPath())+len(r.URL.RawQuery)+1 > 4096 {
		return PassageOptions{}, bad(414, "段落搜索地址最多 4096 字节。")
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return PassageOptions{}, bad(400, "搜索参数格式无效。")
	}
	allowed := map[string]bool{"q": true, "tag": true, "pathId": true, "limit": true, "offset": true}
	for key, values := range query {
		if !allowed[key] || len(values) != 1 {
			return PassageOptions{}, bad(400, "搜索参数未知或重复。")
		}
	}
	options := PassageOptions{Query: query.Get("q"), Tag: query.Get("tag"), PathID: query.Get("pathId"), Limit: 12}
	if query.Has("limit") {
		options.Limit, err = strconv.Atoi(query.Get("limit"))
		if err != nil || options.Limit < 1 {
			return PassageOptions{}, bad(400, "分页数量应为 1 至 40。")
		}
	}
	if query.Has("offset") {
		options.Offset, err = strconv.Atoi(query.Get("offset"))
		if err != nil {
			return PassageOptions{}, bad(400, "分页起点无效。")
		}
	}
	return options, validPassageOptions(options)
}

func (h *handler) passages(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	options, err := passageRequest(r)
	if err != nil {
		respondError(w, err)
		return
	}
	data, err := h.store.SearchPassages(options)
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, data)
}
