package content

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

func (h *handler) workspaces(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/api/workspaces" {
		switch r.Method {
		case "GET", "HEAD":
			values, err := h.store.listWorkspaces()
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 200, map[string]any{"workspaces": values})
		case "POST":
			var input workspaceRequest
			if err := decodeResearch(w, r, &input, 128<<10); err != nil {
				respondError(w, err)
				return
			}
			if input.Version != 0 {
				respondError(w, bad(400, "新专题不能指定已有版本。"))
				return
			}
			value, err := h.store.writeWorkspace("", input)
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 201, value)
		default:
			method(w, "GET, HEAD, POST")
		}
		return
	}
	id := strings.TrimPrefix(path, "/api/workspaces/")
	if !strings.HasPrefix(path, "/api/workspaces/") || !documentID.MatchString(id) {
		respondError(w, bad(404, "专题不存在。"))
		return
	}
	switch r.Method {
	case "GET", "HEAD":
		value, err := h.store.getWorkspace(id)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, value)
	case "PUT":
		var input workspaceRequest
		if err := decodeResearch(w, r, &input, 128<<10); err != nil {
			respondError(w, err)
			return
		}
		if !validResearchVersion(input.Version) {
			respondError(w, bad(400, "专题版本无效。"))
			return
		}
		value, err := h.store.writeWorkspace(id, input)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, value)
	case "DELETE":
		var input researchDelete
		if err := decodeResearch(w, r, &input, 1024); err != nil {
			respondError(w, err)
			return
		}
		if err := h.store.deleteWorkspace(id, input.Version); err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, map[string]bool{"deleted": true})
	default:
		method(w, "GET, HEAD, PUT, DELETE")
	}
}
func (s *Store) listWorkspaces() ([]Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadResearchLocked()
	if err != nil {
		return nil, err
	}
	values := []Workspace{}
	for _, value := range state.Workspaces {
		values = append(values, value)
	}
	sort.Slice(values, func(i, j int) bool {
		if order := researchTimeCompare(values[i].UpdatedAt, values[j].UpdatedAt); order != 0 {
			return order > 0
		}
		return values[i].ID < values[j].ID
	})
	return values, nil
}
func (s *Store) getWorkspace(id string) (Workspace, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadResearchLocked()
	if err != nil {
		return Workspace{}, err
	}
	value, ok := state.Workspaces[id]
	if !ok {
		return Workspace{}, bad(404, "专题不存在。")
	}
	return value, nil
}
func (s *Store) writeWorkspace(id string, input workspaceRequest) (Workspace, error) {
	value := Workspace{ID: id, Title: input.Title, Description: input.Description, DocumentIDs: input.DocumentIDs, Questions: input.Questions, Positions: input.Positions}
	if value.Positions == nil {
		value.Positions = []WorkspacePosition{}
	}
	if err := validateWorkspace(value); err != nil {
		return Workspace{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadResearchLocked()
	if err != nil {
		return Workspace{}, err
	}
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	previousRefs := map[string]bool{}
	if id == "" {
		if len(state.Workspaces) >= maxWorkspaces {
			return Workspace{}, bad(413, "专题数量已达 50 个，请先整理现有专题。")
		}
		id, err = researchID()
		if err != nil {
			return Workspace{}, err
		}
		value.ID = id
		value.Version = 1
		value.CreatedAt = stamp
	} else {
		old, exists := state.Workspaces[id]
		if !exists {
			return Workspace{}, bad(404, "专题不存在。")
		}
		if input.Version != old.Version {
			return Workspace{}, researchConflict()
		}
		if old.Version == maxSafeRevision {
			return Workspace{}, bad(409, "专题版本已达上限。")
		}
		value.Version = old.Version + 1
		value.CreatedAt = old.CreatedAt
		for _, doc := range old.DocumentIDs {
			previousRefs[doc] = true
		}
	}
	for _, doc := range value.DocumentIDs {
		if err = s.researchDocumentLocked(doc, false); err != nil {
			// Retain honest unavailable references from this workspace, while
			// requiring newly added documents to exist. Corrupt/unsafe storage
			// remains a failure even for a previously saved reference.
			if known, ok := err.(*apiError); ok && known.Status == 404 && previousRefs[doc] {
				continue
			}
			return Workspace{}, err
		}
	}
	value.UpdatedAt = stamp
	state.Workspaces[id] = value
	if err = s.saveResearchLocked(state); err != nil {
		return Workspace{}, err
	}
	return value, nil
}
func (s *Store) deleteWorkspace(id string, version int64) error {
	if !validResearchVersion(version) {
		return bad(400, "专题版本无效。")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadResearchLocked()
	if err != nil {
		return err
	}
	value, exists := state.Workspaces[id]
	if !exists {
		return bad(404, "专题不存在。")
	}
	if value.Version != version {
		return researchConflict()
	}
	delete(state.Workspaces, id)
	return s.saveResearchLocked(state)
}
