package content

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

const maxOfflineRevisionIDs = 20
const maxOfflineRevisionURLBytes = 1024

type OfflineRevision struct {
	ID        string `json:"id"`
	Available bool   `json:"available"`
	Version   int    `json:"version,omitempty"`
}
type OfflineRevisionsData struct {
	Revisions []OfflineRevision `json:"revisions"`
}

func offlineRevisionIDs(r *http.Request) ([]string, error) {
	if len(r.URL.EscapedPath())+1+len(r.URL.RawQuery) > maxOfflineRevisionURLBytes {
		return nil, bad(414, "离线版本检查地址最多 1024 字节。")
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["ids"]) != 1 {
		return nil, bad(400, "请只提交一个 ids 查询参数。")
	}
	ids := strings.Split(query.Get("ids"), ",")
	if len(ids) < 1 || len(ids) > maxOfflineRevisionIDs {
		return nil, bad(400, "每次请检查 1 至 20 个唯一文档标识。")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !documentID.MatchString(id) || seen[id] {
			return nil, bad(400, "文档标识无效或重复。")
		}
		seen[id] = true
	}
	return ids, nil
}

func (h *handler) offlineRevisions(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	ids, err := offlineRevisionIDs(r)
	if err != nil {
		respondError(w, err)
		return
	}
	data, err := h.store.offlineRevisions(ids)
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, data)
}

// Version intentionally matches the existing published Detail.Version. Draft
// edits conservatively invalidate an encrypted copy without disclosing their
// content. This path never invokes Markdown, Wiki resolution, or graph builds.
func (s *Store) offlineRevisions(ids []string) (OfflineRevisionsData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := OfflineRevisionsData{Revisions: []OfflineRevision{}}
	for _, id := range ids {
		item := OfflineRevision{ID: id}
		record, err := s.loadLocked(id)
		if err != nil {
			var known *apiError
			if !errors.As(err, &known) || known.Status != 404 {
				return OfflineRevisionsData{}, err
			}
		} else if record.Status == "published" && record.Published != nil {
			item.Available = true
			item.Version = record.Version
		}
		result.Revisions = append(result.Revisions, item)
	}
	return result, nil
}
