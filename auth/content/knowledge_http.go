package content

import (
	"crypto/rand"
	"math/big"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

func knowledgeLimit(r *http.Request, defaultValue, maximum int) (int, error) {
	if !r.URL.Query().Has("limit") {
		return defaultValue, nil
	}
	value, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || value < 1 || value > maximum {
		return 0, bad(400, "知识连接分页数量无效。")
	}
	return value, nil
}

func (h *handler) knowledge(w http.ResponseWriter, r *http.Request, path string) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	if path == "/api/random" {
		value, err := h.store.RandomArticle()
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, value)
		return
	}
	view, err := validLinkView(r.URL.Query().Get("view"))
	if err != nil {
		respondError(w, err)
		return
	}
	maximum := 300
	if path == "/api/link-targets" {
		maximum = 20
	}
	limit, err := knowledgeLimit(r, maximum, maximum)
	if err != nil {
		respondError(w, err)
		return
	}
	query := r.URL.Query().Get("q")
	if utf8.RuneCountInString(query) > 256 {
		respondError(w, bad(400, "搜索内容过长。"))
		return
	}
	h.store.mu.RLock()
	defer h.store.mu.RUnlock()
	index, err := h.store.linksLocked(view)
	if err != nil {
		respondError(w, err)
		return
	}
	if path == "/api/graph" {
		respond(w, 200, index.graph(limit))
		return
	}
	respond(w, 200, index.completions(query, limit))
}

func (h *handler) documentLinks(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	view, err := validLinkView(r.URL.Query().Get("view"))
	if err != nil {
		respondError(w, err)
		return
	}
	h.store.mu.RLock()
	defer h.store.mu.RUnlock()
	index, err := h.store.linksLocked(view)
	if err != nil {
		respondError(w, err)
		return
	}
	data, err := index.links(id)
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, data)
}

func (index *linkIndex) graph(limit int) GraphData {
	result := GraphData{Nodes: []GraphNode{}, Edges: []GraphEdge{}, TotalNodes: len(index.order), TotalEdges: len(index.edges)}
	selected := map[string]bool{}
	edgeLimit := limit * 8
	if edgeLimit > 2400 {
		edgeLimit = 2400
	}
	for _, id := range index.order {
		if len(result.Nodes) >= limit {
			break
		}
		node := index.documents[id].node
		node.Tags = append([]string{}, node.Tags...)
		result.Nodes = append(result.Nodes, node)
		selected[id] = true
	}
	for _, edge := range index.edges {
		if selected[edge.Source] && selected[edge.Target] && len(result.Edges) < edgeLimit {
			result.Edges = append(result.Edges, edge)
		}
	}
	result.Truncated = len(result.Nodes) < result.TotalNodes || len(result.Edges) < result.TotalEdges
	return result
}

func (index *linkIndex) completions(query string, limit int) CompletionData {
	result := CompletionData{Documents: []completionTarget{}}
	query = normalized(strings.TrimSpace(query))
	for _, id := range index.order {
		doc := index.documents[id]
		matches := strings.Contains(normalized(doc.node.Title), query) || id == query
		for _, alias := range doc.aliases {
			if strings.Contains(normalized(alias), query) {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		result.Total++
		result.Documents = append(result.Documents, completionTarget{id, doc.node.Title, doc.status})
		sort.Slice(result.Documents, func(i, j int) bool {
			if result.Documents[i].Title != result.Documents[j].Title {
				return result.Documents[i].Title < result.Documents[j].Title
			}
			return result.Documents[i].ID < result.Documents[j].ID
		})
		if len(result.Documents) > limit {
			result.Documents = result.Documents[:limit]
		}
	}
	result.Truncated = len(result.Documents) < result.Total
	return result
}

func (index *linkIndex) links(id string) (LinkData, error) {
	doc, exists := index.documents[id]
	if !exists {
		return LinkData{}, bad(404, "文档在当前视图中不存在。")
	}
	result := LinkData{Outgoing: []linkTarget{}, Backlinks: []linkTarget{}, Unresolved: append([]unresolvedLink{}, doc.unresolved...)}
	outgoing, backlinks := map[string]bool{}, map[string]bool{}
	for _, edge := range index.edges {
		if edge.Source == id && !outgoing[edge.Target] {
			result.Outgoing = append(result.Outgoing, linkTarget{edge.Target, index.documents[edge.Target].node.Title})
			outgoing[edge.Target] = true
		}
		if edge.Target == id && !backlinks[edge.Source] {
			result.Backlinks = append(result.Backlinks, linkTarget{edge.Source, index.documents[edge.Source].node.Title})
			backlinks[edge.Source] = true
		}
	}
	sortedLinkTargets(result.Outgoing)
	sortedLinkTargets(result.Backlinks)
	if len(result.Backlinks) > 300 {
		result.Backlinks = result.Backlinks[:300]
		result.Truncated = true
	}
	return result, nil
}

// Random selection does not require the optional knowledge index to fit its
// cache budget. Even a space with many disconnected notes can revisit articles.
func (s *Store) RandomArticle() (*Summary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries, err := os.ReadDir(s.root + "/documents")
	if err != nil {
		return nil, bad(500, "文章列表暂时无法读取。")
	}
	var selected *Summary
	count := int64(0)
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !strings.HasSuffix(entry.Name(), ".json") || !documentID.MatchString(id) {
			continue
		}
		record, err := s.searchRecordLocked(id, true, false)
		if err != nil {
			return nil, err
		}
		if record.status != "published" || record.published == nil || record.published.summary.Kind == "note" {
			continue
		}
		count++
		pick, err := rand.Int(rand.Reader, big.NewInt(count))
		if err != nil {
			return nil, bad(503, "暂时无法选择文章。")
		}
		if pick.Int64() == 0 {
			summary := copySummary(record.published.summary)
			selected = &summary
		}
	}
	return selected, nil
}
