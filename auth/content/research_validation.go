package content

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var researchQuestionID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func researchText(value string, limit int, required bool) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= limit && (!required || strings.TrimSpace(value) != "") && strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) < 0
}
func validQuote(q TextQuote) bool {
	return researchText(q.Exact, 2000, true) && researchText(q.Prefix, 128, false) && researchText(q.Suffix, 128, false)
}
func validColor(c string) bool          { return c == "mint" || c == "violet" || c == "amber" }
func validResearchVersion(v int64) bool { return v >= 1 && v <= maxSafeRevision }
func validResearchTimes(created, updated string) bool {
	a, e1 := time.Parse(time.RFC3339Nano, created)
	b, e2 := time.Parse(time.RFC3339Nano, updated)
	return e1 == nil && e2 == nil && !a.After(b)
}

func researchTimeCompare(a, b string) int {
	first, _ := time.Parse(time.RFC3339Nano, a)
	second, _ := time.Parse(time.RFC3339Nano, b)
	return first.Compare(second)
}
func validateWorkspace(w Workspace) error {
	if !researchText(w.Title, 160, true) || strings.IndexFunc(w.Title, unicode.IsControl) >= 0 || !researchText(w.Description, 4000, false) || w.DocumentIDs == nil || w.Questions == nil || len(w.DocumentIDs) > 100 || len(w.Questions) > 50 || len(w.Positions) > 100 {
		return bad(400, "专题标题、说明或条目数量无效。")
	}
	docs := map[string]bool{}
	for _, id := range w.DocumentIDs {
		if !documentID.MatchString(id) || docs[id] {
			return bad(400, "专题文档标识无效或重复。")
		}
		docs[id] = true
	}
	questions := map[string]bool{}
	for _, q := range w.Questions {
		if !researchQuestionID.MatchString(q.ID) || questions[q.ID] || !researchText(q.Text, 1000, true) {
			return bad(400, "专题问题格式无效或重复。")
		}
		questions[q.ID] = true
	}
	positions := map[string]bool{}
	for _, p := range w.Positions {
		if !docs[p.ID] || positions[p.ID] || math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) || math.Abs(p.X) > 100000 || math.Abs(p.Y) > 100000 {
			return bad(400, "专题节点位置无效。")
		}
		positions[p.ID] = true
	}
	return nil
}
func validateResearchFile(state *researchFile) error {
	if state.SchemaVersion != 1 || state.Annotations == nil || state.Workspaces == nil || len(state.Annotations) > maxAnnotations || len(state.Workspaces) > maxWorkspaces {
		return bad(500, "研究状态格式异常或超出预算，请检查备份。")
	}
	counts := map[string]int{}
	for id, a := range state.Annotations {
		counts[a.DocumentID]++
		if id != a.ID || !documentID.MatchString(id) || !documentID.MatchString(a.DocumentID) || !validQuote(a.Quote) || !researchText(a.Body, 8000, false) || !validColor(a.Color) || !validResearchVersion(a.Version) || !validResearchTimes(a.CreatedAt, a.UpdatedAt) || counts[a.DocumentID] > maxDocumentAnnotations {
			return bad(500, "批注状态格式异常，请检查备份。")
		}
	}
	for id, w := range state.Workspaces {
		if id != w.ID || !documentID.MatchString(id) || !validResearchVersion(w.Version) || !validResearchTimes(w.CreatedAt, w.UpdatedAt) || w.Positions == nil || validateWorkspace(w) != nil {
			return bad(500, "专题状态格式异常，请检查备份。")
		}
	}
	return nil
}

// Reject duplicate object keys and null values before decoding. Both can hide
// malformed fields when ordinary struct decoding silently keeps the last value.
func strictResearchJSON(data []byte, value any) error {
	if !utf8.Valid(data) || len(bytes.TrimSpace(data)) == 0 || bytes.TrimSpace(data)[0] != '{' {
		return bad(400, "研究请求必须是 JSON 对象。")
	}
	shape := json.NewDecoder(bytes.NewReader(data))
	shape.UseNumber()
	if err := researchJSONValue(shape, 0); err != nil {
		return err
	}
	if _, err := shape.Token(); err != io.EOF {
		return bad(400, "研究请求包含多余内容。")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		return bad(400, "研究请求字段或格式无效。")
	}
	var raw any
	if json.Unmarshal(data, &raw) != nil || !researchJSONShape(raw, reflect.TypeOf(value)) {
		return bad(400, "研究记录字段缺失或名称无效。")
	}
	return nil
}

// Struct decoding accepts missing scalars and case-folded aliases. Match the
// exact schema recursively so damaged disk state never acquires invented values.
func researchJSONShape(raw any, shape reflect.Type) bool {
	for shape.Kind() == reflect.Pointer {
		shape = shape.Elem()
	}
	switch shape.Kind() {
	case reflect.Struct:
		object, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		fields := map[string]reflect.Type{}
		for i := 0; i < shape.NumField(); i++ {
			field := shape.Field(i)
			tag := strings.Split(field.Tag.Get("json"), ",")
			name := tag[0]
			if name == "" {
				name = field.Name
			}
			if name == "-" {
				continue
			}
			fields[name] = field.Type
			_, present := object[name]
			if !present && (len(tag) < 2 || tag[1] != "omitempty") {
				return false
			}
		}
		for name, value := range object {
			field, exists := fields[name]
			if !exists || !researchJSONShape(value, field) {
				return false
			}
		}
	case reflect.Map:
		object, ok := raw.(map[string]any)
		if !ok {
			return false
		}
		for _, value := range object {
			if !researchJSONShape(value, shape.Elem()) {
				return false
			}
		}
	case reflect.Slice:
		array, ok := raw.([]any)
		if !ok {
			return false
		}
		for _, value := range array {
			if !researchJSONShape(value, shape.Elem()) {
				return false
			}
		}
	}
	return true
}
func researchJSONValue(d *json.Decoder, depth int) error {
	if depth > 16 {
		return bad(400, "研究请求嵌套过深。")
	}
	token, err := d.Token()
	if err != nil || token == nil {
		return bad(400, "研究请求包含无效或空字段。")
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	if delimiter != '{' && delimiter != '[' {
		return bad(400, "研究请求结构无效。")
	}
	seen := map[string]bool{}
	for d.More() {
		if delimiter == '{' {
			key, err := d.Token()
			name, ok := key.(string)
			// encoding/json matches struct field names without case; aliases
			// must count as duplicates too, rather than silently overriding.
			name = strings.ToLower(name)
			if err != nil || !ok || seen[name] {
				return bad(400, "研究请求字段重复或无效。")
			}
			seen[name] = true
		}
		if err := researchJSONValue(d, depth+1); err != nil {
			return err
		}
	}
	end, err := d.Token()
	if err != nil || (delimiter == '{' && end != json.Delim('}')) || (delimiter == '[' && end != json.Delim(']')) {
		return bad(400, "研究请求结构不完整。")
	}
	return nil
}
