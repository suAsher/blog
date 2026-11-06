package content

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func learningRecordsInput(ids ...string) map[string]any {
	value := learningV2Input()
	if ids == nil {
		ids = []string{}
	}
	learningV2Chapter(value)["practiceDocumentIds"] = ids
	return value
}

func TestLearningRecordsPreserveClearAndCAS(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	doc := mustCreate(t, s, input("private practice draft"))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningRecordsInput(doc.ID)))
	path := "/api/learning-paths/" + created["id"].(string)
	legacy := learningInput()
	legacy["version"] = 1
	updated := researchData(t, apiCall(h, "PUT", path, legacy))
	if !reflect.DeepEqual(learningV2Chapter(updated)["practiceDocumentIds"], []any{doc.ID}) {
		t.Fatal("legacy update lost evidence")
	}
	if learningV2Chapter(updated)["practiced"] != true {
		t.Fatal("evidence changed completion")
	}
	if strings.Contains(string(mustJSON(t, updated)), "private practice draft") {
		t.Fatal("route leaked source")
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	if persisted := researchData(t, apiCall(NewHandler(reopened), "GET", path, nil)); !reflect.DeepEqual(updated, persisted) {
		t.Fatal("evidence did not persist")
	}
	legacy["version"] = 2
	learningV2Chapter(legacy)["exercise"] = "A revised exercise"
	changed := researchData(t, apiCall(h, "PUT", path, legacy))
	if learningV2Chapter(changed)["practiced"] == true || !reflect.DeepEqual(learningV2Chapter(changed)["practiceDocumentIds"], []any{doc.ID}) {
		t.Fatal("exercise edit must keep evidence but reset completion")
	}
	if w := apiCall(h, "PUT", path, legacy); w.Code != 409 {
		t.Fatal("CAS bypass", w.Code)
	}
	legacy["version"] = 3
	learningV2Chapter(legacy)["practiceDocumentIds"] = []string{}
	cleared := researchData(t, apiCall(h, "PUT", path, legacy))
	if list, ok := learningV2Chapter(cleared)["practiceDocumentIds"].([]any); ok && len(list) > 0 {
		t.Fatal("empty did not clear")
	}
	if _, err := s.Get(doc.ID, ""); err != nil {
		t.Fatal("unlinked document lost", err)
	}
}

func TestLearningRecordsUnavailableAndChapterIdentity(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	doc := mustCreate(t, s, input("evidence"))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningRecordsInput(doc.ID)))
	path := "/api/learning-paths/" + created["id"].(string)
	if _, err := s.Action(doc.ID, "trash", doc.Version); err != nil {
		t.Fatal(err)
	}
	legacy := learningInput()
	legacy["version"] = 1
	preserved := researchData(t, apiCall(h, "PUT", path, legacy))
	if !reflect.DeepEqual(learningV2Chapter(preserved)["practiceDocumentIds"], []any{doc.ID}) {
		t.Fatal("unavailable reference lost")
	}
	for _, id := range []string{doc.ID, strings.Repeat("f", 32)} {
		if w := apiCall(h, "POST", "/api/learning-paths", learningRecordsInput(id)); w.Code != 404 {
			t.Fatal("unavailable new reference accepted", w.Code)
		}
	}
	legacy["version"] = 2
	learningV2Chapter(legacy)["id"] = "replacement"
	replaced := researchData(t, apiCall(h, "PUT", path, legacy))
	if learningV2Chapter(replaced)["practiceDocumentIds"] != nil {
		t.Fatal("new chapter inherited removed evidence")
	}
}

func TestLearningRecordsValidationAndBudgets(t *testing.T) {
	h := NewHandler(testStore(t))
	for _, invalid := range []any{nil, "invalid", 4, []any{nil}, []string{"invalid"}, []string{strings.Repeat("a", 32), strings.Repeat("a", 32)}} {
		value := learningInput()
		learningV2Chapter(value)["practiceDocumentIds"] = invalid
		if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 400 {
			t.Fatal("invalid evidence accepted", invalid, w.Code)
		}
	}
	s := testStore(t)
	h = NewHandler(s)
	ids := []string{}
	for i := 0; i < 21; i++ {
		ids = append(ids, mustCreate(t, s, input(fmt.Sprintf("evidence %d", i))).ID)
	}
	if w := apiCall(h, "POST", "/api/learning-paths", learningRecordsInput(ids...)); w.Code != 413 {
		t.Fatal("chapter budget bypass", w.Code)
	}
	value := learningRecordsInput(ids[:20]...)
	chapters := []any{}
	for i := 0; i < 5; i++ {
		chapter := learningV2Chapter(learningRecordsInput(ids[:20]...))
		chapter["id"] = fmt.Sprintf("chapter-%d", i)
		chapters = append(chapters, chapter)
	}
	value["chapters"] = chapters
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	if len(created["chapters"].([]any)) != 5 {
		t.Fatal("cross-chapter reuse rejected")
	}
	value["chapters"] = append(chapters, map[string]any{"id": "sixth", "title": "Another", "description": "", "documentIds": []string{}, "practiceDocumentIds": []string{ids[0]}})
	if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 413 {
		t.Fatal("route count budget bypass", w.Code)
	}
}

func TestLearningRecordsEmptyCreationIsIdempotent(t *testing.T) {
	h := NewHandler(testStore(t))
	value := learningRecordsInput()
	value["creationKey"] = "records-empty"
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	again := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	if again["id"] != created["id"] || again["version"] != created["version"] {
		t.Fatal("empty list changed fingerprint")
	}
}

func TestLearningRecordsMergedBudgetPreservesState(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	ids := []string{}
	for i := 0; i < 20; i++ {
		ids = append(ids, mustCreate(t, s, input(fmt.Sprintf("record %d", i))).ID)
	}
	value := learningInput()
	chapters := []any{}
	for i := 0; i < 5; i++ {
		chapter := learningV2Chapter(learningRecordsInput(ids...))
		chapter["id"] = fmt.Sprintf("chapter-%d", i)
		chapters = append(chapters, chapter)
	}
	value["chapters"] = chapters
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	path := "/api/learning-paths/" + created["id"].(string)
	// An older client preserves omitted evidence by stable ID. A new chapter must
	// not use that omission to evade the total reference budget after the merge.
	next := []any{}
	for i := 0; i < 5; i++ {
		chapter := learningV2Chapter(learningInput())
		chapter["id"] = fmt.Sprintf("chapter-%d", i)
		next = append(next, chapter)
	}
	next = append(next, map[string]any{"id": "extra", "title": "Extra", "description": "", "documentIds": []string{}, "practiceDocumentIds": []string{ids[0]}})
	value["chapters"], value["version"] = next, 1
	if w := apiCall(h, "PUT", path, value); w.Code != 413 {
		t.Fatal("merged reference budget bypassed", w.Code)
	}
	current := researchData(t, apiCall(h, "GET", path, nil))
	if !reflect.DeepEqual(current, created) {
		t.Fatal("rejected request changed persisted state")
	}
}
