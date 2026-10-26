package content

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"sync"
	"syscall"
)

const linkIndexBudget int64 = 4 << 20
const maxLinkIndexFiles = 8192

type linkTarget struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type unresolvedLink struct {
	Title  string `json:"title"`
	Reason string `json:"reason"`
}
type LinkData struct {
	Outgoing   []linkTarget     `json:"outgoing"`
	Backlinks  []linkTarget     `json:"backlinks"`
	Unresolved []unresolvedLink `json:"unresolved"`
	Truncated  bool             `json:"truncated"`
}
type GraphNode struct {
	ID    string   `json:"id"`
	Title string   `json:"title"`
	Tags  []string `json:"tags"`
	Kind  string   `json:"kind"`
}
type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Kind   string `json:"kind"`
}
type GraphData struct {
	Nodes      []GraphNode `json:"nodes"`
	Edges      []GraphEdge `json:"edges"`
	TotalNodes int         `json:"totalNodes"`
	TotalEdges int         `json:"totalEdges"`
	Truncated  bool        `json:"truncated"`
}
type completionTarget struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}
type CompletionData struct {
	Documents []completionTarget `json:"documents"`
	Total     int                `json:"total"`
	Truncated bool               `json:"truncated"`
}
type linkDocument struct {
	node       GraphNode
	status     string
	aliases    []string
	references []wikiReference
	related    []string
	unresolved []unresolvedLink
}
type linkIndex struct {
	documents      map[string]linkDocument
	order          []string
	exact, aliases map[string]string // Empty ID means several distinct matches.
	edges          []GraphEdge
	bytes          int64
}
type linkCache struct {
	mu                sync.Mutex
	view, fingerprint string
	value             *linkIndex
	limit             int64
}

func newLinkCache(limit int64) *linkCache { return &linkCache{limit: limit} }
func (c *linkCache) invalidate()          { c.mu.Lock(); c.value = nil; c.fingerprint = ""; c.mu.Unlock() }
func linkBudgetError() error {
	return &apiError{Status: 503, Code: "LINK_INDEX_BUDGET", Message: "知识连接索引超出安全预算，请拆分空间或减少标题别名及链接。正文仍可正常阅读与保存。"}
}
func (index *linkIndex) charge(bytes, limit int64) error {
	if bytes < 0 || index.bytes+bytes > limit {
		return linkBudgetError()
	}
	index.bytes += bytes
	return nil
}

func validLinkView(view string) (string, error) {
	if view == "" {
		return "published", nil
	}
	if view != "published" && view != "working" {
		return "", bad(400, "链接视图无效。")
	}
	return view, nil
}

// Fingerprints include inode, size, mode, mtime and ctime. They detect restores
// and external edits as well as writes made by this process. Only a 32-byte hash
// is retained; there is no unbounded per-file metadata cache.
func (s *Store) linkFilesLocked() ([]string, string, error) {
	directory, err := os.Open(s.root + "/documents")
	if err != nil {
		return nil, "", bad(500, "知识连接暂时无法读取。")
	}
	defer directory.Close()
	ids := []string{}
	for {
		entries, err := directory.ReadDir(128)
		if err != nil && err != io.EOF {
			return nil, "", bad(500, "知识连接暂时无法读取。")
		}
		for _, entry := range entries {
			id := strings.TrimSuffix(entry.Name(), ".json")
			if strings.HasSuffix(entry.Name(), ".json") && documentID.MatchString(id) {
				if len(ids) >= maxLinkIndexFiles {
					return nil, "", linkBudgetError()
				}
				ids = append(ids, id)
			}
		}
		if err == io.EOF {
			break
		}
	}
	sort.Strings(ids)
	hash := sha256.New()
	for _, id := range ids {
		info, err := os.Lstat(s.root + "/documents/" + id + ".json")
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
			return nil, "", bad(500, "知识连接文档暂时无法读取。")
		}
		inode := uint64(0)
		if stat, ok := info.Sys().(*syscall.Stat_t); ok {
			inode = stat.Ino
		}
		change := changeTime(info)
		_, _ = fmt.Fprintf(hash, "%s:%d:%d:%d:%d:%d:%d\n", id, info.Size(), info.Mode(), inode, info.ModTime().UnixNano(), change[0], change[1])
	}
	return ids, fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func addTitleMatch(matches map[string]string, title, id string) {
	key := normalized(strings.TrimSpace(title))
	if previous, exists := matches[key]; !exists || previous == id {
		matches[key] = id
	} else {
		matches[key] = ""
	}
}
func (index *linkIndex) resolve(target string) wikiResolution {
	if documentID.MatchString(target) {
		if _, exists := index.documents[target]; exists {
			return wikiResolution{ID: target}
		}
		return wikiResolution{Reason: "missing"}
	}
	key := normalized(strings.TrimSpace(target))
	for _, matches := range []map[string]string{index.exact, index.aliases} {
		if id, exists := matches[key]; exists {
			if id == "" {
				return wikiResolution{Reason: "ambiguous"}
			}
			return wikiResolution{ID: id}
		}
	}
	return wikiResolution{Reason: "missing"}
}

func (s *Store) buildLinksLocked(ids []string, view string, limit int64) (*linkIndex, error) {
	index := &linkIndex{documents: map[string]linkDocument{}, order: []string{}, exact: map[string]string{}, aliases: map[string]string{}, edges: []GraphEdge{}}
	if err := index.charge(1024, limit); err != nil {
		return nil, err
	}
	for _, id := range ids {
		record, err := s.searchRecordLocked(id, view == "published", false)
		if err != nil {
			return nil, err
		}
		if record.status == "trash" || view == "published" && (record.status != "published" || record.published == nil) {
			continue
		}
		content, aliases := record.working, record.workingAliases
		if view == "published" {
			content, aliases = record.published, record.publishedAliases
		}
		summary := content.summary
		doc := linkDocument{node: GraphNode{id, summary.Title, append([]string{}, summary.Tags...), summary.Kind}, status: record.status, aliases: append([]string{}, aliases...), related: append([]string{}, summary.Related...), unresolved: []unresolvedLink{}}
		if strings.Contains(content.source, "[[") {
			doc.references = extractWikiLinks(content.source)
		}
		cost := int64(768 + len(id)*3 + len(summary.Title)*3 + len(summary.Kind) + len(record.status))
		for _, tag := range doc.node.Tags {
			cost += int64(32 + len(tag))
		}
		for _, alias := range aliases {
			cost += int64(96 + len(alias)*3)
		}
		for _, reference := range doc.references {
			cost += int64(96 + len(reference.Target) + len(reference.Label))
		}
		cost += int64(len(doc.related) * 80)
		if err := index.charge(cost, limit); err != nil {
			return nil, err
		}
		index.documents[id] = doc
		index.order = append(index.order, id)
		addTitleMatch(index.exact, summary.Title, id)
		for _, alias := range aliases {
			addTitleMatch(index.aliases, alias, id)
		}
	}
	if err := index.connect(limit); err != nil {
		return nil, err
	}
	return index, nil
}

func (index *linkIndex) connect(limit int64) error {
	for _, id := range index.order {
		doc := index.documents[id]
		seenEdges := map[string]bool{}
		seenMissing := map[string]bool{}
		addEdge := func(target, kind string) error {
			if target == id || seenEdges[target+":"+kind] {
				return nil
			}
			if err := index.charge(int64(96+len(id)+len(target)+len(kind)), limit); err != nil {
				return err
			}
			seenEdges[target+":"+kind] = true
			index.edges = append(index.edges, GraphEdge{id, target, kind})
			return nil
		}
		for _, reference := range doc.references {
			resolved := index.resolve(reference.Target)
			if resolved.ID != "" {
				if err := addEdge(resolved.ID, "wiki"); err != nil {
					return err
				}
				continue
			}
			key := reference.Target + ":" + resolved.Reason
			if !seenMissing[key] {
				doc.unresolved = append(doc.unresolved, unresolvedLink{reference.Target, resolved.Reason})
				seenMissing[key] = true
			}
		}
		for _, related := range doc.related {
			if _, exists := index.documents[related]; exists {
				if err := addEdge(related, "related"); err != nil {
					return err
				}
			}
		}
		doc.references = nil // Resolved edges are sufficient after the immutable build.
		index.documents[id] = doc
	}
	return nil
}

// Store.mu must be held first. The cache never acquires Store.mu, and a failed
// derived rebuild cannot roll back or corrupt an already committed document.
func (s *Store) linksLocked(view string) (*linkIndex, error) {
	ids, fingerprint, err := s.linkFilesLocked()
	if err != nil {
		return nil, err
	}
	s.links.mu.Lock()
	defer s.links.mu.Unlock()
	if s.links.value != nil && s.links.view == view && s.links.fingerprint == fingerprint {
		return s.links.value, nil
	}
	index, err := s.buildLinksLocked(ids, view, s.links.limit)
	if err != nil {
		return nil, err
	}
	_, after, err := s.linkFilesLocked()
	if err != nil {
		return nil, err
	}
	if fingerprint != after {
		return nil, bad(503, "知识连接构建期间文档发生变化，请重试。")
	}
	s.links.value = index
	s.links.view = view
	s.links.fingerprint = fingerprint
	return index, nil
}

func (s *Store) wikiResolverLocked(view string) wikiResolver {
	if view != "published" {
		view = "working"
	}
	index, err := s.linksLocked(view)
	if err != nil {
		return func(string) wikiResolution { return wikiResolution{Reason: "unavailable"} }
	}
	return index.resolve
}

func sortedLinkTargets(values []linkTarget) {
	sort.Slice(values, func(i, j int) bool {
		if values[i].Title != values[j].Title {
			return values[i].Title < values[j].Title
		}
		return values[i].ID < values[j].ID
	})
}
