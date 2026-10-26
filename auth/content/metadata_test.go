package content

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func metadataResult(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var envelope struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil || !envelope.OK {
		t.Fatalf("response %d: %s", w.Code, w.Body.String())
	}
	return envelope.Data
}

func metadataInput() map[string]any {
	return map[string]any{"title": "随手记", "source": "真正写下的想法", "tags": []string{}, "kind": "note", "maturity": "growing", "series": "日常思考", "related": []string{strings.Repeat("a", 32)}}
}

func TestOptionalMetadataRoundTripAndOldClientPreservation(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	w := apiCall(h, "POST", "/api/documents", metadataInput())
	if w.Code != 201 {
		t.Fatalf("new metadata rejected: %s", w.Body.String())
	}
	d := metadataResult(t, w)
	id := d["id"].(string)
	if d["kind"] != "note" || d["maturity"] != "growing" || d["series"] != "日常思考" || len(d["related"].([]any)) != 1 {
		t.Fatal(d)
	}
	d = metadataResult(t, apiCall(h, "POST", "/api/documents/"+id+"/publish", map[string]any{"version": d["version"]}))
	old := map[string]any{"title": "老客户端编辑", "source": "新内容", "tags": []string{}, "version": d["version"]}
	d = metadataResult(t, apiCall(h, "PUT", "/api/documents/"+id, old))
	if d["kind"] != "note" || d["series"] != "日常思考" || d["maturity"] != "growing" || len(d["related"].([]any)) != 1 {
		t.Fatal("old client erased optional metadata", d)
	}
	clear := map[string]any{"title": "清空元数据", "source": "新内容", "tags": []string{}, "version": d["version"], "kind": "", "maturity": "", "series": "", "related": []string{}}
	d = metadataResult(t, apiCall(h, "PUT", "/api/documents/"+id, clear))
	if d["kind"] != "article" || d["maturity"] != "" || d["series"] != "" || len(d["related"].([]any)) != 0 {
		t.Fatal("explicit clear failed", d)
	}
	live := metadataResult(t, apiCall(h, "GET", "/api/documents/"+id+"?view=published", nil))
	if live["kind"] != "note" || live["series"] != "日常思考" || len(live["related"].([]any)) != 1 {
		t.Fatal("metadata leaked into snapshot", live)
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	live = metadataResult(t, apiCall(NewHandler(reopened), "GET", "/api/documents/"+id+"?view=published", nil))
	if live["series"] != "日常思考" {
		t.Fatal("metadata not durable")
	}
}

func TestOptionalMetadataRejectsInvalidAndNullFields(t *testing.T) {
	h := NewHandler(testStore(t))
	for _, key := range []string{"kind", "maturity", "series", "related"} {
		v := metadataInput()
		v[key] = nil
		if w := apiCall(h, "POST", "/api/documents", v); w.Code != 400 {
			t.Fatalf("null %s accepted: %s", key, w.Body.String())
		}
	}
	for _, patch := range []map[string]any{
		{"kind": "task"}, {"maturity": "published"}, {"series": strings.Repeat("中", 101)},
		{"series": "bad\nseries"}, {"related": []string{"invalid"}}, {"related": make([]string, 33)},
		{"related": "not-an-array"}, {"unknown": true},
	} {
		v := metadataInput()
		for k, value := range patch {
			v[k] = value
		}
		if w := apiCall(h, "POST", "/api/documents", v); w.Code != 400 {
			t.Fatalf("invalid metadata accepted: %#v %s", patch, w.Body.String())
		}
	}
	w := apiCall(h, "POST", "/api/documents", input("base"))
	d := metadataResult(t, w)
	for _, key := range []string{"kind", "maturity", "series", "related"} {
		v := map[string]any{"title": "title", "source": "source", "version": d["version"], key: nil}
		if w := apiCall(h, "PUT", "/api/documents/"+d["id"].(string), v); w.Code != 400 {
			t.Fatalf("PUT null %s accepted", key)
		}
	}
	v := metadataInput()
	v["related"] = []string{d["id"].(string)}
	v["version"] = d["version"]
	if w := apiCall(h, "PUT", "/api/documents/"+d["id"].(string), v); w.Code != 400 {
		t.Fatal("self relation accepted")
	}
}

func TestOptionalMetadataDefaultsImportAndExport(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	d := metadataResult(t, apiCall(h, "POST", "/api/documents", input("body")))
	if d["kind"] != "article" || d["maturity"] != "" || d["series"] != "" || d["related"] == nil {
		t.Fatal("default metadata unavailable", d)
	}
	front := "---\ntitle: 元数据\nkind: note\nmaturity: evergreen\nseries: 笔记\nrelated:\n  - " + strings.Repeat("b", 32) + "\n---\n正文"
	c, err := parseImported("note.md", []byte(front))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := markdownExport(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"kind: note", "maturity: evergreen", "series: 笔记", strings.Repeat("b", 32)} {
		if !strings.Contains(string(encoded), text) {
			t.Fatalf("metadata lost in import/export: %s", encoded)
		}
	}
	for _, front := range []string{"kind: null", "maturity: null", "series: null", "related: null", "related: invalid"} {
		if _, err := parseImported("bad.md", []byte("---\ntitle: bad\n"+front+"\n---\nbody")); err == nil {
			t.Fatalf("invalid YAML metadata accepted: %s", front)
		}
	}
}

func TestMetadataSearchListAndDuplicateRelationIsolation(t *testing.T) {
	s := testStore(t)
	c := input("body")
	c.Kind = "note"
	c.Series = "系列"
	c.Maturity = "evergreen"
	c.Related = []string{strings.Repeat("a", 32), strings.Repeat("a", 32)}
	d := mustCreate(t, s, c)
	if len(d.Related) != 1 {
		t.Fatal("relations not deduplicated")
	}
	d, _ = s.Action(d.ID, "publish", d.Version)
	list, err := s.List(ListOptions{Status: "published", Limit: 24})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Documents) != 1 || list.Documents[0].Kind != "note" || list.Documents[0].Series != "系列" || list.Documents[0].Maturity != "evergreen" {
		t.Fatal("list lost metadata")
	}
	searched, err := s.List(ListOptions{Status: "published", Query: "系列", Limit: 24})
	if err != nil || searched.Total != 1 {
		t.Fatal("series metadata unavailable to search")
	}
	list.Documents[0].Related[0] = strings.Repeat("b", 32)
	list, _ = s.List(ListOptions{Status: "published", Limit: 24})
	if list.Documents[0].Related[0] != strings.Repeat("a", 32) {
		t.Fatal("caller mutated shared search snapshot")
	}
	c.Related[0] = strings.Repeat("c", 32)
	live, _ := s.Get(d.ID, "published")
	if live.Related[0] != strings.Repeat("a", 32) {
		t.Fatal("caller mutated published metadata")
	}
}

func TestMetadataRecordBudgetRejectsUnboundedDerivedFields(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	s.mu.Lock()
	record, err := s.loadLocked(d.ID)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	record.Activity = make([]activityBucket, maxActivityDays+1)
	if err := s.saveLocked(record); err == nil {
		t.Fatal("unbounded activity accepted")
	}
	record.Activity = nil
	record.Working.Series = strings.Repeat("a", 17<<10)
	if err := s.saveLocked(record); err == nil {
		t.Fatal("metadata budget not enforced")
	}
	live, err := s.Get(d.ID, "")
	if err != nil || live.Series != "" {
		t.Fatal("failed write changed durable content")
	}
}
