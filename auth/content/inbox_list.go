package content

import (
	"sort"
	"strings"
)

func (s *Store) listInbox(options inboxOptions) (inboxData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadInboxLocked()
	if err != nil {
		return inboxData{}, err
	}
	learning, err := s.loadLearningLocked()
	if err != nil {
		return inboxData{}, err
	}
	routes, membership := inboxRoutes(learning)
	result := inboxData{Version: state.Version, Documents: []inboxDocument{}, Routes: routes, Views: append([]inboxView{}, state.Views...)}
	directory, err := s.openDocumentRoot()
	if err != nil {
		return inboxData{}, err
	}
	defer directory.Close()
	handle, err := directory.Open(".")
	if err != nil {
		return inboxData{}, bad(500, "收件箱文档目录暂时无法打开。")
	}
	defer handle.Close()
	files, err := handle.ReadDir(-1)
	if err != nil {
		return inboxData{}, bad(500, "收件箱文档暂时无法读取。")
	}
	tags := map[string]int{}
	for _, file := range files {
		id := strings.TrimSuffix(file.Name(), ".json")
		if !strings.HasSuffix(file.Name(), ".json") || !documentID.MatchString(id) {
			continue
		}
		record, err := s.searchRecordInRootLocked(directory, id, false, false)
		if err != nil {
			return inboxData{}, err
		}
		if record.status == "trash" {
			continue
		}
		summary := record.working.summary
		// The inbox is a metadata-only workspace. Never return source snippets.
		summary.Body = ""
		summary.Tags = append([]string{}, summary.Tags...)
		summary.Related = append([]string{}, summary.Related...)
		stage := "pending"
		if saved, ok := state.Entries[id]; ok {
			stage = saved.Stage
		}
		item := inboxDocument{Summary: summary, Stage: stage, Routes: append([]inboxRoute{}, membership[id]...)}
		result.Counts.All++
		if stage == "pending" {
			result.Counts.Pending++
		}
		if stage == "organized" {
			result.Counts.Unverified++
		}
		if stage == "verified" {
			result.Counts.Verified++
		}
		if len(item.Routes) == 0 {
			result.Counts.Unassigned++
		}
		for _, tag := range summary.Tags {
			tags[tag]++
		}
		if inboxMatches(item, options.Filter) {
			result.Documents = append(result.Documents, item)
		}
	}
	result.Tags = facetList(tags)
	sort.SliceStable(result.Documents, func(i, j int) bool {
		a, b := result.Documents[i], result.Documents[j]
		if order := researchTimeCompare(a.UpdatedAt, b.UpdatedAt); order != 0 {
			return order > 0
		}
		return a.ID < b.ID
	})
	result.Total = len(result.Documents)
	start := min(options.Offset, result.Total)
	end := start + min(options.Limit, result.Total-start)
	result.Documents = append([]inboxDocument{}, result.Documents[start:end]...)
	return result, nil
}

func inboxRoutes(state *learningFile) ([]inboxRoute, map[string][]inboxRoute) {
	routes := []inboxRoute{}
	for _, path := range state.Paths {
		routes = append(routes, inboxRoute{ID: path.ID, Title: path.Title})
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Title != routes[j].Title {
			return routes[i].Title < routes[j].Title
		}
		return routes[i].ID < routes[j].ID
	})
	membership := map[string][]inboxRoute{}
	for _, route := range routes {
		for id := range learningDocumentSet(state.Paths[route.ID].Chapters) {
			membership[id] = append(membership[id], route)
		}
	}
	return routes, membership
}

func inboxMatches(item inboxDocument, filter inboxFilter) bool {
	if (filter.View == "pending" && item.Stage != "pending") ||
		(filter.View == "unverified" && item.Stage != "organized") ||
		(filter.View == "verified" && item.Stage != "verified") ||
		(filter.View == "unassigned" && len(item.Routes) != 0) {
		return false
	}
	if filter.Tag != "" {
		matched := false
		for _, tag := range item.Tags {
			if normalized(tag) == normalized(filter.Tag) {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	if filter.RouteID != "" {
		matched := false
		for _, route := range item.Routes {
			if route.ID == filter.RouteID {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	metadata := normalized(strings.Join([]string{item.Title, item.Description, strings.Join(item.Tags, " "), item.Category, item.Series}, " "))
	for _, token := range strings.Fields(normalized(filter.Query)) {
		if !strings.Contains(metadata, token) {
			return false
		}
	}
	return true
}
