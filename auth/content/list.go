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
func snippet(source string, tokens []string) string {
	text := strings.Join(strings.Fields(source), " ")
	runes := []rune(text)
	start := 0
	normalizedText := normalized(text)
	for _, token := range tokens {
		if at := strings.Index(normalizedText, token); at >= 0 {
			start = utf8.RuneCountInString(normalizedText[:at]) - 50
			if start < 0 {
				start = 0
			}
			break
		}
	}
	end := start + 220
	if end > len(runes) {
		end = len(runes)
	}
	if start > len(runes) {
		start = 0
	}
	value := string(runes[start:end])
	if start > 0 {
		value = "…" + value
	}
	if end < len(runes) {
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
		d, err := s.loadLocked(strings.TrimSuffix(name, ".json"))
		if err != nil {
			return ListData{}, err
		}
		switch d.Status {
		case "draft":
			stats.Draft++
		case "published":
			stats.Published++
		case "trash":
			stats.Trash++
		}
		if (options.Status == "all" && d.Status == "trash") || (options.Status != "all" && options.Status != d.Status) {
			continue
		}
		c := d.Working
		if options.Status == "published" {
			if d.Published == nil {
				continue
			}
			c = *d.Published
		}
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
		title := normalized(c.Title)
		description := normalized(c.Description)
		text := title + "\n" + description + "\n" + normalized(strings.Join(c.Tags, " ")) + "\n" + normalized(c.Source)
		score := 0
		found := true
		for _, token := range tokens {
			if !strings.Contains(text, token) {
				found = false
				break
			}
			if strings.Contains(title, token) {
				score += 10
			}
			if strings.Contains(description, token) {
				score += 3
			}
		}
		if !found {
			continue
		}
		item := summary(d, c)
		if len(tokens) > 0 {
			item.Body = snippet(c.Source, tokens)
		}
		matches = append(matches, match{item, score})
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
		documents = append(documents, item.summary)
	}
	return ListData{Documents: documents, Total: total, Tags: facetList(tags), Categories: facetList(categories), Stats: stats, Quota: s.quota()}, nil
}
