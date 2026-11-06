package content

import (
	"strings"
	"time"
	"unicode"
)

const (
	maxInboxBytes   = 2 << 20
	maxInboxEntries = 10000
	maxInboxViews   = 12
)

type inboxEntry struct {
	Stage     string `json:"stage"`
	UpdatedAt string `json:"updatedAt"`
}
type inboxFilter struct {
	View    string `json:"view"`
	Query   string `json:"q"`
	Tag     string `json:"tag"`
	RouteID string `json:"routeId"`
}
type inboxView struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Filter inboxFilter `json:"filter"`
}
type inboxFile struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Version       int64                 `json:"version"`
	Entries       map[string]inboxEntry `json:"entries"`
	Views         []inboxView           `json:"views"`
}
type inboxRoute struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}
type inboxDocument struct {
	Summary
	Stage  string       `json:"stage"`
	Routes []inboxRoute `json:"routes"`
}
type inboxCounts struct {
	Pending    int `json:"pending"`
	Unassigned int `json:"unassigned"`
	Unverified int `json:"unverified"`
	Verified   int `json:"verified"`
	All        int `json:"all"`
}
type inboxData struct {
	Version   int64           `json:"version"`
	Documents []inboxDocument `json:"documents"`
	Total     int             `json:"total"`
	Counts    inboxCounts     `json:"counts"`
	Tags      []Facet         `json:"tags"`
	Routes    []inboxRoute    `json:"routes"`
	Views     []inboxView     `json:"views"`
}
type inboxOptions struct {
	Filter        inboxFilter
	Limit, Offset int
}
type inboxBatchRequest struct {
	Version     int64    `json:"version"`
	DocumentIDs []string `json:"documentIds"`
	Stage       string   `json:"stage"`
}
type inboxViewsRequest struct {
	Version int64       `json:"version"`
	Views   []inboxView `json:"views"`
}

func newInboxFile() *inboxFile {
	return &inboxFile{SchemaVersion: 1, Entries: map[string]inboxEntry{}, Views: []inboxView{}}
}
func validInboxVersion(version int64) bool {
	return version >= 0 && version <= maxSafeRevision
}
func validInboxStage(stage string) bool {
	return stage == "pending" || stage == "organized" || stage == "verified"
}
func validInboxFilter(filter inboxFilter) bool {
	validView := filter.View == "pending" || filter.View == "unassigned" || filter.View == "unverified" || filter.View == "verified" || filter.View == "all"
	return validView && researchText(filter.Query, 256, false) && researchText(filter.Tag, 80, false) &&
		(filter.RouteID == "" || documentID.MatchString(filter.RouteID))
}
func validateInboxViews(views []inboxView) error {
	if views == nil || len(views) > maxInboxViews {
		return bad(400, "最多保存 12 个筛选视图。")
	}
	ids := map[string]bool{}
	for _, view := range views {
		if !researchQuestionID.MatchString(view.ID) || ids[view.ID] || !researchText(view.Name, 60, true) ||
			strings.IndexFunc(view.Name, unicode.IsControl) >= 0 || !validInboxFilter(view.Filter) {
			return bad(400, "筛选视图名称、条件或标识无效。")
		}
		ids[view.ID] = true
	}
	return nil
}
func validateInboxFile(state *inboxFile) error {
	if state.SchemaVersion != 1 || !validInboxVersion(state.Version) || state.Entries == nil ||
		len(state.Entries) > maxInboxEntries || validateInboxViews(state.Views) != nil {
		return bad(500, "收件箱状态异常或超出预算，请检查备份。")
	}
	for id, entry := range state.Entries {
		_, err := time.Parse(time.RFC3339Nano, entry.UpdatedAt)
		if !documentID.MatchString(id) || !validInboxStage(entry.Stage) || err != nil {
			return bad(500, "收件箱记录异常，请检查备份。")
		}
	}
	return nil
}
func inboxConflict() error {
	return &apiError{Status: 409, Code: "VERSION_CONFLICT", Message: "收件箱已在其他页面更新。当前选择仍保留，请读取最新状态后再保存。"}
}
