package content

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

func (h *handler) learningPaths(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/api/learning-paths" {
		switch r.Method {
		case "GET", "HEAD":
			values, err := h.store.listLearning()
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 200, map[string]any{"paths": values})
		case "POST":
			var input learningRequest
			if err := decodeResearch(w, r, &input, 128<<10); err != nil {
				respondError(w, err)
				return
			}
			if input.Version != 0 {
				respondError(w, bad(400, "新路线不能指定已有版本。"))
				return
			}
			value, err := h.store.writeLearning("", input)
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
	id := strings.TrimPrefix(path, "/api/learning-paths/")
	if !documentID.MatchString(id) {
		respondError(w, bad(404, "路线不存在。"))
		return
	}
	switch r.Method {
	case "GET", "HEAD":
		value, err := h.store.getLearning(id)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, value)
	case "PUT":
		var input learningRequest
		if err := decodeResearch(w, r, &input, 128<<10); err != nil {
			respondError(w, err)
			return
		}
		if !validResearchVersion(input.Version) {
			respondError(w, bad(400, "路线版本无效。"))
			return
		}
		value, err := h.store.writeLearning(id, input)
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
		if err := h.store.deleteLearning(id, input.Version); err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, map[string]bool{"deleted": true})
	default:
		method(w, "GET, HEAD, PUT, DELETE")
	}
}
func (s *Store) listLearning() ([]LearningPath, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadLearningLocked()
	if err != nil {
		return nil, err
	}
	values := []LearningPath{}
	for _, value := range state.Paths {
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
func (s *Store) getLearning(id string) (LearningPath, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadLearningLocked()
	if err != nil {
		return LearningPath{}, err
	}
	value, ok := state.Paths[id]
	if !ok {
		return LearningPath{}, bad(404, "路线不存在。")
	}
	return value, nil
}
func learningDocumentSet(chapters []LearningChapter) map[string]bool {
	ids := map[string]bool{}
	for _, chapter := range chapters {
		for _, id := range chapter.DocumentIDs {
			ids[id] = true
		}
	}
	return ids
}
func (s *Store) writeLearning(id string, input learningRequest) (LearningPath, error) {
	value := LearningPath{ID: id, Title: input.Title, Description: input.Description, Accent: input.Accent, Chapters: input.Chapters}
	if err := validateLearning(value); err != nil {
		return LearningPath{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadLearningLocked()
	if err != nil {
		return LearningPath{}, err
	}
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	previous := map[string]bool{}
	if id == "" {
		if len(state.Paths) >= 50 {
			return LearningPath{}, bad(413, "路线数量已达 50 条，请先整理。")
		}
		id, err = researchID()
		if err != nil {
			return LearningPath{}, err
		}
		value.ID = id
		value.Version = 1
		value.CreatedAt = stamp
	} else {
		old, exists := state.Paths[id]
		if !exists {
			return LearningPath{}, bad(404, "路线不存在。")
		}
		if old.Version != input.Version || old.Version == maxSafeRevision {
			return LearningPath{}, researchConflict()
		}
		value.Version = old.Version + 1
		value.CreatedAt = old.CreatedAt
		previous = learningDocumentSet(old.Chapters)
	}
	for doc := range learningDocumentSet(value.Chapters) {
		if err := s.researchDocumentLocked(doc, false); err != nil {
			if known, ok := err.(*apiError); ok && known.Status == 404 && previous[doc] {
				continue
			}
			return LearningPath{}, err
		}
	}
	value.UpdatedAt = stamp
	state.Paths[id] = value
	if err := s.saveLearningLocked(state); err != nil {
		return LearningPath{}, err
	}
	return value, nil
}
func (s *Store) deleteLearning(id string, version int64) error {
	if !validResearchVersion(version) {
		return bad(400, "路线版本无效。")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadLearningLocked()
	if err != nil {
		return err
	}
	value, exists := state.Paths[id]
	if !exists {
		return bad(404, "路线不存在。")
	}
	if value.Version != version {
		return researchConflict()
	}
	delete(state.Paths, id)
	return s.saveLearningLocked(state)
}
