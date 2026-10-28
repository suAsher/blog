package content

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// Embedded snapshots share the document's atomic rename and fsync. Retention is
// deliberately bounded by both count and encoded size, rather than an unbounded
// file per autosave. Legacy records without history remain valid.
const maxHistoryEntries = 12
const maxHistoryBytes = 6 << 20

type HistorySummary struct {
	Revision int    `json:"revision"`
	Title    string `json:"title"`
	SavedAt  string `json:"savedAt"`
	Reason   string `json:"reason"`
}
type HistorySnapshot struct {
	HistorySummary
	Content Content           `json:"content"`
	Aliases map[string]string `json:"aliases,omitempty"`
}
type HistoryData struct {
	History []HistorySummary `json:"history"`
}

func copyAliases(previous map[string]string) map[string]string {
	result := make(map[string]string, len(previous))
	for key, value := range previous {
		result[key] = value
	}
	return result
}
func historySize(history []HistorySnapshot) int {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(history)
	return b.Len()
}
func rememberHistory(d *record, reason string) {
	history := append([]HistorySnapshot{}, d.History...)
	history = append(history, HistorySnapshot{HistorySummary{d.Version, d.Working.Title, d.UpdatedAt, reason}, copyContent(d.Working), copyAliases(d.Aliases)})
	for len(history) > maxHistoryEntries || historySize(history) > maxHistoryBytes {
		history = history[1:]
	}
	d.History = history
}
func validateHistory(d *record) error {
	if len(d.History) > maxHistoryEntries || historySize(d.History) > maxHistoryBytes {
		return bad(413, "版本历史超出保留预算。")
	}
	previous := 0
	for _, entry := range d.History {
		if entry.Revision <= previous || entry.Revision >= d.Version || entry.Title != entry.Content.Title {
			return bad(400, "历史版本标识无效。")
		}
		if entry.Reason != "update" && entry.Reason != "publish" && entry.Reason != "restore" && entry.Reason != "import" {
			return bad(400, "历史版本操作无效。")
		}
		if _, err := time.Parse(time.RFC3339Nano, entry.SavedAt); err != nil {
			return bad(400, "历史版本时间无效。")
		}
		if _, err := normalizeContent(entry.Content); err != nil {
			return err
		}
		if err := validateAliases(entry.Aliases); err != nil {
			return err
		}
		for _, target := range entry.Content.Related {
			if target == d.ID {
				return bad(400, "历史版本不能关联自身。")
			}
		}
		previous = entry.Revision
	}
	return nil
}
func (s *Store) History(id string) (HistoryData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return HistoryData{}, err
	}
	result := HistoryData{History: []HistorySummary{}}
	for i := len(d.History) - 1; i >= 0; i-- {
		result.History = append(result.History, d.History[i].HistorySummary)
	}
	return result, nil
}
func (s *Store) HistoryRevision(id string, revision int) (HistorySnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return HistorySnapshot{}, err
	}
	for _, entry := range d.History {
		if entry.Revision == revision {
			entry.Content = copyContent(entry.Content)
			entry.Aliases = nil
			return entry, nil
		}
	}
	return HistorySnapshot{}, bad(404, "历史版本不存在或已超出保留范围。")
}
func (s *Store) publishedHistory(id string) (HistorySnapshot, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return HistorySnapshot{}, err
	}
	if d.Published == nil {
		return HistorySnapshot{}, bad(404, "文档尚未发布。")
	}
	return HistorySnapshot{HistorySummary: HistorySummary{d.Version, d.Published.Title, d.PublishedAt, "published"}, Content: copyContent(*d.Published)}, nil
}
func (s *Store) RestoreHistory(id string, version, revision int) (Detail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return Detail{}, err
	}
	if d.Version != version {
		return Detail{}, bad(409, "文档已更新，请重新加载后恢复历史版本。")
	}
	if d.Status == "trash" {
		return Detail{}, bad(409, "请先从垃圾箱恢复文档。")
	}
	var selected *HistorySnapshot
	for i := range d.History {
		if d.History[i].Revision == revision {
			snapshot := d.History[i]
			selected = &snapshot
			break
		}
	}
	if selected == nil {
		return Detail{}, bad(404, "历史版本不存在或已超出保留范围。")
	}
	if sameContent(d.Working, selected.Content) && sameAliases(d.Aliases, selected.Aliases) {
		return s.detail(d, "")
	}
	next, err := nextDocumentVersion(d.Version)
	if err != nil {
		return Detail{}, err
	}
	rememberHistory(d, "restore")
	if d.Working.Title != selected.Content.Title {
		d.WorkingTitleAliases = rememberTitle(d.WorkingTitleAliases, d.Working.Title)
	}
	if d.Working.Source != selected.Content.Source {
		d.Activity = addActivity(d.Activity, s.now())
	}
	preservePublishedAliases(d)
	d.Working = copyContent(selected.Content)
	d.Aliases = copyAliases(selected.Aliases)
	d.Version = next
	d.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if err = s.saveLocked(d); err != nil {
		return Detail{}, err
	}
	return s.detail(d, "")
}
func sameAliases(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}
func (h *handler) documentHistory(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case "GET", "HEAD":
		value := r.URL.Query().Get("revision")
		if value == "" {
			data, err := h.store.History(id)
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 200, data)
			return
		}
		var snapshot HistorySnapshot
		var err error
		if value == "published" {
			snapshot, err = h.store.publishedHistory(id)
		} else {
			revision, parseErr := strconv.Atoi(value)
			if parseErr != nil || revision < 1 {
				respondError(w, bad(400, "历史版本编号无效。"))
				return
			}
			snapshot, err = h.store.HistoryRevision(id, revision)
		}
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, snapshot)
	case "POST":
		var value struct {
			Version  int `json:"version"`
			Revision int `json:"revision"`
		}
		if err := decodeJSON(w, r, &value); err != nil {
			respondError(w, err)
			return
		}
		document, err := h.store.RestoreHistory(id, value.Version, value.Revision)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, document)
	default:
		method(w, "GET, HEAD, POST")
	}
}

func publishedAliases(d *record) map[string]string {
	if d.PublishedAliases != nil {
		return *d.PublishedAliases
	}
	return d.Aliases
}
func preservePublishedAliases(d *record) {
	if d.Published != nil && d.PublishedAliases == nil {
		snapshot := copyAliases(d.Aliases)
		d.PublishedAliases = &snapshot
	}
}

func validateAliases(aliases map[string]string) error {
	if len(aliases) > maxStructureMarkers {
		return bad(413, "配图映射超出大小限制。")
	}
	for destination, location := range aliases {
		if len(destination) == 0 || int64(len(destination)) > MaxSourceBytes || !assetURL.MatchString(location) {
			return bad(400, "配图映射格式无效。")
		}
	}
	return nil
}
