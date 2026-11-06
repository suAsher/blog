package content

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (h *handler) inbox(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/api/inbox" {
		if r.Method != "GET" && r.Method != "HEAD" {
			method(w, "GET, HEAD")
			return
		}
		options, err := parseInboxOptions(r)
		if err != nil {
			respondError(w, err)
			return
		}
		data, err := h.store.listInbox(options)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, data)
		return
	}
	if path != "/api/inbox/batch" && path != "/api/inbox/views" {
		respondError(w, bad(404, "收件箱接口不存在。"))
		return
	}
	if r.Method != "PUT" {
		method(w, "PUT")
		return
	}
	var version int64
	var err error
	if path == "/api/inbox/batch" {
		var input inboxBatchRequest
		if err = decodeResearch(w, r, &input, 32<<10); err == nil {
			version, err = h.store.writeInboxBatch(input)
		}
	} else {
		var input inboxViewsRequest
		if err = decodeResearch(w, r, &input, 32<<10); err == nil {
			version, err = h.store.writeInboxViews(input)
		}
	}
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, map[string]int64{"version": version})
}

func parseInboxOptions(r *http.Request) (inboxOptions, error) {
	options := inboxOptions{Filter: inboxFilter{View: "pending"}, Limit: 50}
	q, err := parseInboxQuery(r)
	if err != nil {
		return options, err
	}
	if q["view"] != "" {
		options.Filter.View = q["view"]
	}
	options.Filter.Query, options.Filter.Tag, options.Filter.RouteID = q["q"], q["tag"], q["routeId"]
	if !validInboxFilter(options.Filter) {
		return options, bad(400, "收件箱筛选条件无效或过长。")
	}
	if raw, ok := q["limit"]; ok {
		options.Limit, err = strconv.Atoi(raw)
		if err != nil || options.Limit < 1 || options.Limit > 100 {
			return options, bad(400, "分页数量应为 1 至 100。")
		}
	}
	if raw, ok := q["offset"]; ok {
		options.Offset, err = strconv.Atoi(raw)
		if err != nil || options.Offset < 0 {
			return options, bad(400, "分页起点无效。")
		}
	}
	return options, nil
}
func parseInboxQuery(r *http.Request) (map[string]string, error) {
	allowed := map[string]bool{"view": true, "q": true, "tag": true, "routeId": true, "limit": true, "offset": true}
	values := map[string]string{}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, bad(400, "收件箱筛选参数编码无效。")
	}
	for key, value := range query {
		if !allowed[key] || len(value) != 1 {
			return nil, bad(400, "收件箱筛选参数无效或重复。")
		}
		values[key] = value[0]
	}
	return values, nil
}

func (s *Store) writeInboxBatch(input inboxBatchRequest) (int64, error) {
	if !validInboxVersion(input.Version) || !validInboxStage(input.Stage) || len(input.DocumentIDs) < 1 || len(input.DocumentIDs) > 100 {
		return 0, bad(400, "请选择 1 至 100 篇文档及有效整理状态。")
	}
	ids := map[string]bool{}
	for _, id := range input.DocumentIDs {
		if !documentID.MatchString(id) || ids[id] {
			return 0, bad(400, "文档标识无效或重复。")
		}
		ids[id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadInboxLocked()
	if err != nil {
		return 0, err
	}
	if state.Version != input.Version || state.Version == maxSafeRevision {
		return 0, inboxConflict()
	}
	for _, id := range input.DocumentIDs {
		if err := s.researchDocumentLocked(id, false); err != nil {
			return 0, err
		}
	}
	entries, err := s.retainedInboxEntriesLocked(state.Entries)
	if err != nil {
		return 0, err
	}
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	for _, id := range input.DocumentIDs {
		// Pending is the default, so returning to the inbox also releases space.
		if input.Stage == "pending" {
			delete(entries, id)
		} else {
			entries[id] = inboxEntry{Stage: input.Stage, UpdatedAt: stamp}
		}
	}
	if len(entries) > maxInboxEntries {
		return 0, bad(413, "收件箱状态已达 10000 篇预算，请先整理。")
	}
	next := &inboxFile{SchemaVersion: 1, Version: state.Version + 1, Entries: entries, Views: append([]inboxView{}, state.Views...)}
	if err := s.saveInboxLocked(next); err != nil {
		return 0, err
	}
	return next.Version, nil
}
func (s *Store) writeInboxViews(input inboxViewsRequest) (int64, error) {
	if !validInboxVersion(input.Version) {
		return 0, bad(400, "收件箱版本无效。")
	}
	if err := validateInboxViews(input.Views); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadInboxLocked()
	if err != nil {
		return 0, err
	}
	if state.Version != input.Version || state.Version == maxSafeRevision {
		return 0, inboxConflict()
	}
	views := append([]inboxView{}, input.Views...)
	for i, view := range views {
		views[i] = inboxView{ID: view.ID, Name: strings.TrimSpace(view.Name), Filter: view.Filter}
	}
	next := &inboxFile{SchemaVersion: 1, Version: state.Version + 1, Entries: state.Entries, Views: views}
	if err := s.saveInboxLocked(next); err != nil {
		return 0, err
	}
	return next.Version, nil
}
