package content

import (
	"os"
	"sort"
	"strings"
	"unicode/utf8"
)

func normalized(s string) string {
	return strings.ToLower(strings.Map(func(r rune) rune {
		if r >= 0xff01 && r <= 0xff5e {
			return r - 0xfee0
		}
		if r == 0x3000 {
			return ' '
		}
		return r
	}, s))
}
func facetList(counts map[string]int) []Facet {
	result := []Facet{}
	for name, count := range counts {
		result = append(result, Facet{Name: name, Count: count})
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Count != result[j].Count {
			return result[i].Count > result[j].Count
		}
		return result[i].Name < result[j].Name
	})
	return result
}

// Slice only a short rune window after locating a normalized token. This avoids
// allocating a complete rune/whitespace copy of a multi-megabyte document.
func snippet(source, indexed string, tokens []string) string {
	start := 0
	for _, token := range tokens {
		if at := strings.Index(indexed, token); at >= 0 {
			start = utf8.RuneCountInString(indexed[:at]) - 50
			if start < 0 {
				start = 0
			}
			break
		}
	}
	byteStart, byteEnd, count := 0, len(source), 0
	for at := range source {
		if count == start {
			byteStart = at
		}
		if count == start+220 {
			byteEnd = at
			break
		}
		count++
	}
	value := strings.Join(strings.Fields(source[byteStart:byteEnd]), " ")
	if byteStart > 0 {
		value = "…" + value
	}
	if byteEnd < len(source) {
		value += "…"
	}
	return value
}

func (s *Store) List(options ListOptions) (ListData, error) {
	if options.Status == "" {
		options.Status = "published"
	}
	if options.Status != "published" && options.Status != "draft" && options.Status != "trash" && options.Status != "all" {
		return ListData{}, bad(400, "文档状态无效。")
	}
	if options.Limit <= 0 {
		options.Limit = 24
	}
	if options.Limit > 1000 {
		options.Limit = 1000
	}
	if options.Offset < 0 {
		options.Offset = 0
	}
	if utf8.RuneCountInString(options.Query) > 256 {
		return ListData{}, bad(400, "搜索内容过长。")
	}
	tokens := strings.Fields(normalized(options.Query))
	tags := map[string]int{}
	categories := map[string]int{}
	type match struct {
		summary Summary
		score   int
	}
	matches := []match{}
	stats := Stats{}
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries, err := os.ReadDir(s.root + "/documents")
	if err != nil {
		return ListData{}, bad(500, "文档列表暂时无法读取。")
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || !documentID.MatchString(strings.TrimSuffix(name, ".json")) {
			continue
		}
		d, err := s.searchRecordLocked(strings.TrimSuffix(name, ".json"), options.Status == "published", len(tokens) > 0)
		if err != nil {
			return ListData{}, err
		}
		switch d.status {
		case "draft":
			stats.Draft++
		case "published":
			stats.Published++
		case "trash":
			stats.Trash++
		}
		if (options.Status == "all" && d.status == "trash") || (options.Status != "all" && options.Status != d.status) {
			continue
		}
		view := d.working
		if options.Status == "published" {
			if d.published == nil {
				continue
			}
			view = d.published
		}
		c := view.summary
		for _, tag := range c.Tags {
			tags[tag]++
		}
		if c.Category != "" {
			categories[c.Category]++
		}
		if options.Tag != "" {
			found := false
			for _, tag := range c.Tags {
				if normalized(tag) == normalized(options.Tag) {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if options.Category != "" && normalized(c.Category) != normalized(options.Category) {
			continue
		}
		score, found := view.matches(tokens)
		if !found {
			continue
		}
		matches = append(matches, match{view.summary, score})
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score > matches[j].score
		}
		if options.Status == "published" && matches[i].summary.Date != matches[j].summary.Date {
			return matches[i].summary.Date > matches[j].summary.Date
		}
		if matches[i].summary.UpdatedAt != matches[j].summary.UpdatedAt {
			return matches[i].summary.UpdatedAt > matches[j].summary.UpdatedAt
		}
		return matches[i].summary.ID < matches[j].summary.ID
	})
	total := len(matches)
	start := options.Offset
	if start > total {
		start = total
	}
	end := start + options.Limit
	if end > total {
		end = total
	}
	documents := []Summary{}
	for _, item := range matches[start:end] {
		summary := item.summary
		summary.Tags = append([]string{}, summary.Tags...)
		summary.Related = append([]string{}, summary.Related...)
		if len(tokens) > 0 {
			record, err := s.searchRecordLocked(summary.ID, options.Status == "published", true)
			if err != nil {
				return ListData{}, err
			}
			view := record.working
			if options.Status == "published" {
				view = record.published
			}
			summary.Body = snippet(view.source, view.body, tokens)
		}
		documents = append(documents, summary)
	}
	return ListData{Documents: documents, Total: total, Tags: facetList(tags), Categories: facetList(categories), Stats: stats, Quota: s.quota()}, nil
}
