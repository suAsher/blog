package content

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"sort"
	"time"
)

func decodeReadingBatch(w http.ResponseWriter, r *http.Request) ([]readingOperation, error) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return nil, bad(415, "请使用 JSON 提交阅读状态。")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReadingRequestBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, bad(413, "每批阅读同步请求最多 32 KiB。")
		}
		return nil, bad(400, "阅读同步请求无法读取。")
	}
	var payload struct {
		Operations []readingOperationWire `json:"operations"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, bad(400, "阅读同步请求格式无效。")
	}
	return validateReadingOperations(payload.Operations)
}

func (h *handler) readingState(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET", "HEAD":
		data, err := h.store.ReadingState()
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, data)
	case "POST":
		operations, err := decodeReadingBatch(w, r)
		if err != nil {
			respondError(w, err)
			return
		}
		data, err := h.store.updateReading(operations)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, data)
	default:
		method(w, "GET, HEAD, POST")
	}
}

func (h *handler) reviews(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	limit, err := knowledgeLimit(r, 20, 100)
	if err != nil {
		respondError(w, err)
		return
	}
	data, err := h.store.dueReviews(limit)
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, data)
}

func (s *Store) dueReviews(limit int) (ReviewsData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadReadingLocked()
	if err != nil {
		return ReviewsData{}, err
	}
	result := ReviewsData{Due: []DueReview{}}
	now := s.now()
	for key, entry := range state.Entries {
		if entry.Review == nil || !entry.Review.Enabled || entry.Review.DueAt == nil {
			continue
		}
		due, _ := time.Parse(time.RFC3339Nano, *entry.Review.DueAt)
		if due.After(now) {
			continue
		}
		result.Total++
		result.Due = append(result.Due, DueReview{key, *entry.Review.DueAt, entry.Review.Step})
		sort.Slice(result.Due, func(i, j int) bool {
			a, _ := time.Parse(time.RFC3339Nano, result.Due[i].DueAt)
			b, _ := time.Parse(time.RFC3339Nano, result.Due[j].DueAt)
			if !a.Equal(b) {
				return a.Before(b)
			}
			return result.Due[i].Key < result.Due[j].Key
		})
		if len(result.Due) > limit {
			result.Due = result.Due[:limit]
		}
	}
	return result, nil
}
