package content

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var operationUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func safeReadingKey(key string) bool {
	if key == "" || len(key) > 240 || !utf8.ValidString(key) || strings.TrimSpace(key) != key || strings.ContainsAny(key, "\\?#<>\"'") || strings.IndexFunc(key, unicode.IsControl) >= 0 {
		return false
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." || segment == "__proto__" || segment == "constructor" || segment == "prototype" {
			return false
		}
	}
	return true
}

func safeRevision(value int64) bool { return value >= 0 && value <= maxSafeRevision }
func knownReadingField(field string) bool {
	return field == "bookmarked" || field == "read" || field == "progress" || field == "review"
}

func validateReadingOperations(wires []readingOperationWire) ([]readingOperation, error) {
	if len(wires) == 0 || len(wires) > maxReadingOperations {
		return nil, bad(400, "每批需提交 1 至 32 个阅读操作。")
	}
	operations := []readingOperation{}
	seen := map[string]bool{}
	for _, wire := range wires {
		op, err := validateReadingOperation(wire)
		if err != nil {
			return nil, err
		}
		if seen[op.OpID] {
			return nil, bad(400, "同一批次不能重复操作标识。")
		}
		seen[op.OpID] = true
		operations = append(operations, op)
	}
	return operations, nil
}

func validateReadingOperation(wire readingOperationWire) (readingOperation, error) {
	op := readingOperation{OpID: strings.ToLower(wire.OpID), Key: wire.Key, Base: map[string]int64{}, Patch: map[string]json.RawMessage{}}
	if !operationUUID.MatchString(op.OpID) || !safeReadingKey(op.Key) || len(wire.Patch) == 0 || len(wire.Patch) > 4 || len(wire.Base) != len(wire.Patch) {
		return op, bad(400, "阅读操作标识、文章标识或字段格式无效。")
	}
	for patchField, raw := range wire.Patch {
		field := patchField
		if field == "reviewAction" {
			field = "review"
		}
		base, exists := wire.Base[field]
		if !knownReadingField(field) || patchField == "review" || !exists || bytes.Equal(bytes.TrimSpace(base), []byte("null")) || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return op, bad(400, "每个阅读字段必须提供有效基础版本和值。")
		}
		var revision int64
		if json.Unmarshal(base, &revision) != nil || !safeRevision(revision) {
			return op, bad(400, "阅读字段版本必须是安全非负整数。")
		}
		op.Base[field] = revision
		var value any
		switch field {
		case "bookmarked", "read":
			var flag bool
			if json.Unmarshal(raw, &flag) != nil {
				return op, bad(400, "阅读开关必须为布尔值。")
			}
			value = flag
		case "progress":
			var progress float64
			if json.Unmarshal(raw, &progress) != nil || math.IsNaN(progress) || math.IsInf(progress, 0) || progress < 0 || progress > 100 {
				return op, bad(400, "阅读进度应为 0 至 100。")
			}
			value = progress
		case "review":
			var action string
			if json.Unmarshal(raw, &action) != nil || action != "enable" && action != "complete" && action != "disable" {
				return op, bad(400, "复习操作无效。")
			}
			value = action
		}
		canonical, _ := json.Marshal(value)
		op.Patch[patchField] = canonical
	}
	canonical, _ := json.Marshal(struct {
		Key   string                     `json:"key"`
		Base  map[string]int64           `json:"base"`
		Patch map[string]json.RawMessage `json:"patch"`
	}{op.Key, op.Base, op.Patch})
	hash := sha256.Sum256(canonical)
	op.Fingerprint = hex.EncodeToString(hash[:])
	return op, nil
}

func validateReadingFile(state *readingFile) error {
	if state.SchemaVersion != 1 || !safeRevision(state.Revision) || state.Entries == nil || len(state.Entries) > maxReadingEntries || len(state.Receipts) > maxReadingReceipts {
		return bad(500, "阅读状态格式异常，请检查备份。")
	}
	for key, entry := range state.Entries {
		if !safeReadingKey(key) || entry.UpdatedAt < 0 || entry.UpdatedAt > maxSafeRevision || math.IsNaN(entry.Progress) || math.IsInf(entry.Progress, 0) || entry.Progress < 0 || entry.Progress > 100 {
			return bad(500, "阅读状态记录异常，请检查备份。")
		}
		for _, revision := range []int64{entry.FieldRevisions.Bookmarked, entry.FieldRevisions.Read, entry.FieldRevisions.Progress, entry.FieldRevisions.Review} {
			if !safeRevision(revision) || revision > state.Revision {
				return bad(500, "阅读状态版本异常，请检查备份。")
			}
		}
		if err := validateReview(entry.Review); err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	for _, receipt := range state.Receipts {
		if !operationUUID.MatchString(receipt.OpID) || !safeReadingKey(receipt.Key) || len(receipt.Fingerprint) != 64 || seen[receipt.OpID] {
			return bad(500, "阅读操作回执异常，请检查备份。")
		}
		if _, err := hex.DecodeString(receipt.Fingerprint); err != nil {
			return bad(500, "阅读操作回执异常，请检查备份。")
		}
		fields := map[string]bool{}
		for _, list := range [][]string{receipt.Applied, receipt.Conflicts} {
			for _, field := range list {
				if !knownReadingField(field) || fields[field] {
					return bad(500, "阅读操作回执字段异常，请检查备份。")
				}
				fields[field] = true
			}
		}
		if len(fields) == 0 {
			return bad(500, "阅读操作回执为空，请检查备份。")
		}
		seen[receipt.OpID] = true
	}
	return nil
}

func validateReview(review *ReadingReview) error {
	if review == nil {
		return nil
	}
	if review.Step < 0 || review.Step > 3 || review.Enabled != (review.DueAt != nil) {
		return bad(500, "复习计划格式异常，请检查备份。")
	}
	for _, stamp := range []*string{review.DueAt, review.LastReviewedAt} {
		if stamp != nil {
			if _, err := time.Parse(time.RFC3339Nano, *stamp); err != nil {
				return bad(500, "复习计划时间异常，请检查备份。")
			}
		}
	}
	return nil
}
