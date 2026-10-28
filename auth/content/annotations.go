package content

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

func (h *handler) annotations(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/api/annotations" {
		switch r.Method {
		case "GET", "HEAD":
			ids := r.URL.Query()["documentId"]
			if len(ids) != 1 || !documentID.MatchString(ids[0]) {
				respondError(w, bad(400, "请指定有效的批注文档。"))
				return
			}
			values, err := h.store.listAnnotations(ids[0])
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 200, map[string]any{"annotations": values})
		case "POST":
			var input annotationRequest
			if err := decodeResearch(w, r, &input, 64<<10); err != nil {
				respondError(w, err)
				return
			}
			a, err := h.store.createAnnotation(input)
			if err != nil {
				respondError(w, err)
				return
			}
			respond(w, 201, a)
		default:
			method(w, "GET, HEAD, POST")
		}
		return
	}
	id := strings.TrimPrefix(path, "/api/annotations/")
	if !strings.HasPrefix(path, "/api/annotations/") || !documentID.MatchString(id) {
		respondError(w, bad(404, "批注不存在。"))
		return
	}
	switch r.Method {
	case "PUT":
		var input annotationUpdate
		if err := decodeResearch(w, r, &input, 64<<10); err != nil {
			respondError(w, err)
			return
		}
		a, err := h.store.changeAnnotation(id, input, false)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, a)
	case "DELETE":
		var input researchDelete
		if err := decodeResearch(w, r, &input, 1024); err != nil {
			respondError(w, err)
			return
		}
		if _, err := h.store.changeAnnotation(id, annotationUpdate{Version: input.Version}, true); err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, map[string]bool{"deleted": true})
	default:
		method(w, "PUT, DELETE")
	}
}
func (s *Store) listAnnotations(document string) ([]Annotation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err := s.researchDocumentLocked(document, true); err != nil {
		return nil, err
	}
	state, err := s.loadResearchLocked()
	if err != nil {
		return nil, err
	}
	values := []Annotation{}
	for _, a := range state.Annotations {
		if a.DocumentID == document {
			values = append(values, a)
		}
	}
	sort.Slice(values, func(i, j int) bool {
		if order := researchTimeCompare(values[i].CreatedAt, values[j].CreatedAt); order != 0 {
			return order < 0
		}
		return values[i].ID < values[j].ID
	})
	return values, nil
}
func (s *Store) createAnnotation(input annotationRequest) (Annotation, error) {
	if input.Body == nil || input.Quote == nil || !validQuote(*input.Quote) || !researchText(*input.Body, 8000, false) {
		return Annotation{}, bad(400, "批注引文或正文无效。")
	}
	if input.Color == "" {
		input.Color = "mint"
	}
	if !validColor(input.Color) {
		return Annotation{}, bad(400, "批注颜色无效。")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.researchDocumentLocked(input.DocumentID, true); err != nil {
		return Annotation{}, err
	}
	state, err := s.loadResearchLocked()
	if err != nil {
		return Annotation{}, err
	}
	if err := s.reclaimDeletedAnnotationsLocked(state); err != nil {
		return Annotation{}, err
	}
	count := 0
	for _, a := range state.Annotations {
		if a.DocumentID == input.DocumentID {
			count++
		}
	}
	if len(state.Annotations) >= maxAnnotations || count >= maxDocumentAnnotations {
		return Annotation{}, bad(413, "批注数量已达预算，请先整理现有批注。")
	}
	id, err := researchID()
	if err != nil {
		return Annotation{}, err
	}
	stamp := s.now().UTC().Format(time.RFC3339Nano)
	a := Annotation{ID: id, DocumentID: input.DocumentID, Quote: *input.Quote, Body: *input.Body, Color: input.Color, Version: 1, CreatedAt: stamp, UpdatedAt: stamp}
	state.Annotations[id] = a
	if err = s.saveResearchLocked(state); err != nil {
		return Annotation{}, err
	}
	return a, nil
}
func (s *Store) changeAnnotation(id string, input annotationUpdate, remove bool) (Annotation, error) {
	if !validResearchVersion(input.Version) || (!remove && (input.Body == nil || !researchText(*input.Body, 8000, false) || input.Color != "" && !validColor(input.Color))) {
		return Annotation{}, bad(400, "批注版本、正文或颜色无效。")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadResearchLocked()
	if err != nil {
		return Annotation{}, err
	}
	a, exists := state.Annotations[id]
	if !exists {
		return Annotation{}, bad(404, "批注不存在。")
	}
	if !remove {
		if err = s.researchDocumentLocked(a.DocumentID, true); err != nil {
			return Annotation{}, err
		}
	}
	if a.Version != input.Version {
		return Annotation{}, researchConflict()
	}
	if remove {
		delete(state.Annotations, id)
	} else {
		if a.Version == maxSafeRevision {
			return Annotation{}, bad(409, "批注版本已达上限。")
		}
		a.Version++
		a.Body = *input.Body
		if input.Color != "" {
			a.Color = input.Color
		}
		a.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
		state.Annotations[id] = a
	}
	if err = s.saveResearchLocked(state); err != nil {
		return Annotation{}, err
	}
	return a, nil
}
