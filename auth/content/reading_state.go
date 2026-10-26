package content

import (
	"encoding/json"
	"time"
)

func fieldRevision(revisions FieldRevisions, field string) int64 {
	switch field {
	case "bookmarked":
		return revisions.Bookmarked
	case "read":
		return revisions.Read
	case "progress":
		return revisions.Progress
	default:
		return revisions.Review
	}
}
func withFieldRevision(revisions FieldRevisions, field string, value int64) FieldRevisions {
	switch field {
	case "bookmarked":
		revisions.Bookmarked = value
	case "read":
		revisions.Read = value
	case "progress":
		revisions.Progress = value
	case "review":
		revisions.Review = value
	}
	return revisions
}

func applyReview(previous *ReadingReview, action string, now time.Time) (*ReadingReview, error) {
	review := ReadingReview{}
	if previous != nil {
		review = *previous
	}
	var days int
	switch action {
	case "enable":
		review.Enabled = true
		review.Step = 0
		days = 1
	case "complete":
		if !review.Enabled {
			return nil, &apiError{Status: 409, Code: "REVIEW_DISABLED", Message: "这篇文章尚未启用复习，请先设置复习计划。"}
		}
		if review.Step < 3 {
			review.Step++
		}
		days = []int{1, 3, 7, 30}[review.Step]
		stamp := now.UTC().Format(time.RFC3339Nano)
		review.LastReviewedAt = &stamp
	case "disable":
		review.Enabled = false
		review.DueAt = nil
	}
	if days > 0 {
		stamp := now.UTC().Add(time.Duration(days) * 24 * time.Hour).Format(time.RFC3339Nano)
		review.DueAt = &stamp
	}
	return &review, nil
}

func applyReadingOperation(entry ReadingEntry, operation readingOperation, revision int64, now time.Time) (ReadingEntry, []string, []string, error) {
	applied, conflicts := []string{}, []string{}
	for _, field := range []string{"bookmarked", "read", "progress", "review"} {
		patchField := field
		if field == "review" {
			patchField = "reviewAction"
		}
		raw, exists := operation.Patch[patchField]
		if !exists {
			continue
		}
		if operation.Base[field] != fieldRevision(entry.FieldRevisions, field) {
			conflicts = append(conflicts, field)
			continue
		}
		switch field {
		case "bookmarked":
			_ = json.Unmarshal(raw, &entry.Bookmarked)
		case "read":
			_ = json.Unmarshal(raw, &entry.Read)
		case "progress":
			_ = json.Unmarshal(raw, &entry.Progress)
		case "review":
			var action string
			_ = json.Unmarshal(raw, &action)
			review, err := applyReview(entry.Review, action, now)
			if err != nil {
				return ReadingEntry{}, nil, nil, err
			}
			entry.Review = review
		}
		entry.FieldRevisions = withFieldRevision(entry.FieldRevisions, field, revision)
		applied = append(applied, field)
	}
	if len(applied) > 0 {
		stamp := now.UnixMilli()
		if stamp < 0 {
			stamp = 0
		}
		if stamp < entry.UpdatedAt {
			stamp = entry.UpdatedAt
		}
		entry.UpdatedAt = stamp
	}
	return entry, applied, conflicts, nil
}

func (s *Store) ReadingState() (ReadingData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, err := s.loadReadingLocked()
	if err != nil {
		return ReadingData{}, err
	}
	return ReadingData{state.Revision, state.Entries}, nil
}

func (s *Store) updateReading(operations []readingOperation) (ReadingBatchData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadReadingLocked()
	if err != nil {
		return ReadingBatchData{}, err
	}
	receipts := map[string]readingReceipt{}
	for _, receipt := range state.Receipts {
		receipts[receipt.OpID] = receipt
	}
	// Reject a reused identifier before accepting any operation from this batch.
	for _, operation := range operations {
		if receipt, exists := receipts[operation.OpID]; exists && receipt.Fingerprint != operation.Fingerprint {
			return ReadingBatchData{}, &apiError{Status: 409, Code: "OP_ID_REUSE", Message: "操作标识已用于其他内容，请生成新的操作后重试。"}
		}
	}
	result := ReadingBatchData{Results: []ReadingResult{}}
	changed := false
	for _, operation := range operations {
		if receipt, exists := receipts[operation.OpID]; exists {
			result.Results = append(result.Results, ReadingResult{OpID: operation.OpID, Key: operation.Key, Applied: append([]string{}, receipt.Applied...), Conflicts: append([]string{}, receipt.Conflicts...), Replayed: true})
			continue
		}
		previous, exists := state.Entries[operation.Key]
		entry, applied, conflicts, err := applyReadingOperation(previous, operation, state.Revision+1, s.now())
		if err != nil {
			return ReadingBatchData{}, err
		}
		if len(applied) > 0 {
			if !safeRevision(state.Revision + 1) {
				return ReadingBatchData{}, bad(503, "阅读状态版本已达安全上限，请先导出记录并联系维护。")
			}
			if !exists && len(state.Entries) >= maxReadingEntries {
				return ReadingBatchData{}, bad(413, "最多同步 10000 篇文章的阅读状态，请先导出并整理记录。")
			}
			state.Revision++
			state.Entries[operation.Key] = entry
		}
		receipt := readingReceipt{operation.OpID, operation.Key, operation.Fingerprint, applied, conflicts}
		state.Receipts = append(state.Receipts, receipt)
		if len(state.Receipts) > maxReadingReceipts {
			state.Receipts = append([]readingReceipt{}, state.Receipts[len(state.Receipts)-maxReadingReceipts:]...)
		}
		result.Results = append(result.Results, ReadingResult{OpID: operation.OpID, Key: operation.Key, Applied: applied, Conflicts: conflicts})
		changed = true
	}
	if changed {
		if err := s.saveReadingLocked(state); err != nil {
			return ReadingBatchData{}, err
		}
	}
	result.Revision = state.Revision
	for i := range result.Results {
		result.Results[i].Entry = state.Entries[result.Results[i].Key]
	}
	return result, nil
}
