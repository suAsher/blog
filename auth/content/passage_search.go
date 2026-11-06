package content

import (
	"os"
	"sort"
	"strings"
)

const (
	maxPassageResults    = 2000
	maxPassageDocuments  = 1000
	maxPassageScanBytes  = 32 << 20
	maxPassageReadBytes  = 64 << 20
	maxPassageScanBlocks = 32768
	maxPassagePaths      = 8
)

type passageScanBudget struct {
	documents, sourceBytes, blocks int
	recordBytes                    int64
}

func (budget *passageScanBudget) record(size int64) bool {
	if budget.documents == maxPassageDocuments || size > maxPassageReadBytes-budget.recordBytes {
		return false
	}
	budget.documents++
	budget.recordBytes += size
	return true
}

func (budget *passageScanBudget) source(size int) bool {
	if size > maxPassageScanBytes-budget.sourceBytes {
		return false
	}
	budget.sourceBytes += size
	return true
}

func (budget *passageScanBudget) index(size int) bool {
	if size > maxPassageScanBlocks-budget.blocks {
		return false
	}
	budget.blocks += size
	return true
}

type passageMatch struct {
	document Summary
	block    passageBlock
	revision string
	score    int
	order    int
}

func passageScore(block passageBlock, tokens []string) (int, bool) {
	score := 0
	for _, token := range tokens {
		if !strings.Contains(block.indexed, token) {
			return 0, false
		}
		score++
	}
	if block.indexed == strings.Join(tokens, " ") {
		score += 10
	}
	return score, true
}

func passageHasTag(document Summary, tag string) bool {
	if tag == "" {
		return true
	}
	for _, value := range document.Tags {
		if normalized(value) == normalized(tag) {
			return true
		}
	}
	return false
}

func (s *Store) passagePathsLocked(pathID string) (map[string][]PassagePath, error) {
	state, err := s.loadLearningLocked()
	if err != nil {
		return nil, err
	}
	if pathID != "" {
		if _, exists := state.Paths[pathID]; !exists {
			return nil, bad(404, "路线不存在，请重新选择搜索范围。")
		}
	}
	ids := make([]string, 0, len(state.Paths))
	for id := range state.Paths {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	paths := map[string][]PassagePath{}
	for _, id := range ids {
		if pathID != "" && pathID != id {
			continue
		}
		path := state.Paths[id]
		for _, chapter := range path.Chapters {
			context := PassagePath{path.ID, path.Title, chapter.ID, chapter.Title}
			seen := map[string]bool{}
			for _, references := range [][]string{chapter.DocumentIDs, chapter.PracticeDocumentIDs} {
				for _, documentID := range references {
					if !seen[documentID] {
						paths[documentID] = append(paths[documentID], context)
						seen[documentID] = true
					}
				}
			}
		}
	}
	return paths, nil
}

func (s *Store) SearchPassages(options PassageOptions) (PassageData, error) {
	if err := validPassageOptions(options); err != nil {
		return PassageData{}, err
	}
	if options.Limit == 0 {
		options.Limit = 12
	}
	tokens := strings.Fields(normalized(options.Query))
	s.mu.RLock()
	defer s.mu.RUnlock()
	paths, err := s.passagePathsLocked(options.PathID)
	if err != nil {
		return PassageData{}, err
	}
	directory, err := s.openDocumentRoot()
	if err != nil {
		return PassageData{}, err
	}
	defer directory.Close()
	listing, err := directory.Open(".")
	if err != nil {
		return PassageData{}, bad(500, "文档列表暂时无法读取。")
	}
	entries, err := listing.ReadDir(-1)
	listing.Close()
	if err != nil {
		return PassageData{}, bad(500, "文档列表暂时无法读取。")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	matches, truncated, err := s.collectPassagesLocked(directory, entries, options, tokens, paths)
	if err != nil {
		return PassageData{}, err
	}
	return passagePage(matches, paths, tokens, options, truncated), nil
}

func (s *Store) collectPassagesLocked(directory *os.Root, entries []os.DirEntry, options PassageOptions, tokens []string, paths map[string][]PassagePath) ([]passageMatch, bool, error) {
	matches := []passageMatch{}
	truncated := false
	budget := passageScanBudget{}
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !strings.HasSuffix(entry.Name(), ".json") || !documentID.MatchString(id) || options.PathID != "" && len(paths[id]) == 0 {
			continue
		}
		info, err := directory.Lstat(entry.Name())
		if err != nil {
			return nil, false, bad(500, "文档暂时无法读取，请重试。")
		}
		if !budget.record(info.Size()) {
			return matches, true, nil
		}
		record, err := s.searchRecordInRootLocked(directory, id, true, false)
		if err != nil {
			return nil, false, err
		}
		if record.status != "published" || record.published == nil || !passageHasTag(record.published.summary, options.Tag) {
			continue
		}
		view := record.published
		if !budget.source(len(view.source)) {
			return matches, true, nil
		}
		index := s.passages.get(view.source)
		if !budget.index(len(index.blocks)) {
			return matches, true, nil
		}
		truncated = truncated || index.truncated
		for order, block := range index.blocks {
			score, found := passageScore(block, tokens)
			if !found {
				continue
			}
			if len(matches) == maxPassageResults {
				return matches, true, nil
			}
			matches = append(matches, passageMatch{view.summary, block, index.revision, score, order})
		}
	}
	return matches, truncated, nil
}

func passagePage(matches []passageMatch, paths map[string][]PassagePath, tokens []string, options PassageOptions, truncated bool) PassageData {
	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if a.document.PublishedAt != b.document.PublishedAt {
			return a.document.PublishedAt > b.document.PublishedAt
		}
		if a.document.ID != b.document.ID {
			return a.document.ID < b.document.ID
		}
		return a.order < b.order
	})
	result := PassageData{Passages: []PassageResult{}, Total: len(matches), Limit: options.Limit, Offset: options.Offset, Truncated: truncated}
	start := min(options.Offset, len(matches))
	end := min(start+options.Limit, len(matches))
	result.HasMore = end < len(matches)
	for _, match := range matches[start:end] {
		contexts := paths[match.document.ID]
		result.Passages = append(result.Passages, PassageResult{
			DocumentID: match.document.ID, Title: match.document.Title,
			Tags: append([]string{}, match.document.Tags...), Category: match.document.Category,
			PublishedAt: match.document.PublishedAt, Revision: match.revision,
			Anchor: match.block.anchor, Kind: match.block.kind,
			Snippet:   snippet(match.block.text, match.block.indexed, tokens),
			Headings:  append([]Heading{}, match.block.headings...),
			Paths:     append([]PassagePath{}, contexts[:min(len(contexts), maxPassagePaths)]...),
			PathCount: len(contexts),
		})
	}
	if truncated {
		result.Message = "已达到单次检索预算，当前为部分结果；请增加关键词或限定标签、学习路线。"
	}
	return result
}
