package content

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func learningV2Input(ids ...string) map[string]any {
	value := learningInput(ids...)
	value["objectives"] = []string{"解释请求的生命周期", "复现一个失败分支"}
	value["prerequisites"] = []string{"能够运行本地命令"}
	chapter := value["chapters"].([]any)[0].(map[string]any)
	chapter["goal"] = "能解释超时发生在哪一层"
	chapter["exercise"] = "运行示例，记录成功与超时两种输出。"
	chapter["practiced"] = true
	return value
}

func learningV2Chapter(value map[string]any) map[string]any {
	return value["chapters"].([]any)[0].(map[string]any)
}

func TestLearningV2RoundTripAndOldClientPreservation(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	doc := mustCreate(t, s, input("private unpublished body"))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningV2Input(doc.ID)))
	id := created["id"].(string)
	if !reflect.DeepEqual(created["objectives"], []any{"解释请求的生命周期", "复现一个失败分支"}) {
		t.Fatal("route goals did not round trip", created)
	}
	if learningV2Chapter(created)["practiced"] != true {
		t.Fatal("practice status did not round trip", created)
	}
	encoded, _ := json.Marshal(created)
	if strings.Contains(string(encoded), "private unpublished body") {
		t.Fatal("route returned unpublished document body")
	}
	legacy := learningInput(doc.ID)
	legacy["version"] = 1
	updated := researchData(t, apiCall(h, "PUT", "/api/learning-paths/"+id, legacy))
	for _, key := range []string{"objectives", "prerequisites"} {
		if !reflect.DeepEqual(updated[key], created[key]) {
			t.Fatal("old client discarded route metadata", key)
		}
	}
	for _, key := range []string{"goal", "exercise", "practiced"} {
		if learningV2Chapter(updated)[key] != learningV2Chapter(created)[key] {
			t.Fatal("old client discarded chapter metadata", key)
		}
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	persisted := researchData(t, apiCall(NewHandler(reopened), "GET", "/api/learning-paths/"+id, nil))
	if !reflect.DeepEqual(persisted, updated) {
		t.Fatal("stored metadata changed across reopen")
	}
	info, err := os.Stat(filepath.Join(s.root, "state", "learning.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("metadata is not stored privately", err)
	}
}

func TestLearningV2ExplicitClearingAndIndependentPractice(t *testing.T) {
	h := NewHandler(testStore(t))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningV2Input()))
	path := "/api/learning-paths/" + created["id"].(string)
	value := learningInput()
	value["version"] = 1
	learningV2Chapter(value)["practiced"] = false
	updated := researchData(t, apiCall(h, "PUT", path, value))
	if learningV2Chapter(updated)["practiced"] == true || learningV2Chapter(updated)["exercise"] == nil {
		t.Fatal("explicit false did not clear practice independently", updated)
	}
	value["version"] = 2
	value["objectives"] = []string{}
	value["prerequisites"] = []string{}
	learningV2Chapter(value)["goal"] = ""
	learningV2Chapter(value)["exercise"] = ""
	cleared := researchData(t, apiCall(h, "PUT", path, value))
	for _, key := range []string{"objectives", "prerequisites"} {
		if list, ok := cleared[key].([]any); ok && len(list) != 0 {
			t.Fatal("explicit empty list did not clear", key)
		}
	}
	for _, key := range []string{"goal", "exercise"} {
		if text, ok := learningV2Chapter(cleared)[key].(string); ok && text != "" {
			t.Fatal("explicit empty text did not clear", key)
		}
	}
	if w := apiCall(h, "PUT", path, value); w.Code != 409 {
		t.Fatal("practice update bypassed route CAS", w.Code)
	}
}

func TestLearningV2PreservesOnlyMatchingChapterIDs(t *testing.T) {
	h := NewHandler(testStore(t))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningV2Input()))
	path := "/api/learning-paths/" + created["id"].(string)
	value := learningInput()
	value["version"] = 1
	learningV2Chapter(value)["id"] = "replacement"
	updated := researchData(t, apiCall(h, "PUT", path, value))
	if len(updated["chapters"].([]any)) != 1 || learningV2Chapter(updated)["id"] != "replacement" {
		t.Fatal("removed chapter was revived", updated)
	}
	for _, key := range []string{"goal", "exercise", "practiced"} {
		if learningV2Chapter(updated)[key] != nil {
			t.Fatal("new chapter inherited a removed chapter's metadata", key)
		}
	}
	value["version"] = 2
	value["chapters"] = []any{}
	removed := researchData(t, apiCall(h, "PUT", path, value))
	if len(removed["chapters"].([]any)) != 0 {
		t.Fatal("empty chapter list did not remove chapters", removed)
	}
}

func TestLearningV2ChangedExerciseResetsImplicitPractice(t *testing.T) {
	h := NewHandler(testStore(t))
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", learningV2Input()))
	path := "/api/learning-paths/" + created["id"].(string)
	update := learningInput()
	update["version"] = 1
	learningV2Chapter(update)["exercise"] = "比较取消与超时的不同返回。"
	changed := researchData(t, apiCall(h, "PUT", path, update))
	if learningV2Chapter(changed)["practiced"] == true {
		t.Fatal("new exercise inherited completion from a different task")
	}
	update["version"] = 2
	learningV2Chapter(update)["practiced"] = true
	researchData(t, apiCall(h, "PUT", path, update))
	update["version"] = 3
	delete(learningV2Chapter(update), "practiced")
	unchanged := researchData(t, apiCall(h, "PUT", path, update))
	if learningV2Chapter(unchanged)["practiced"] != true {
		t.Fatal("unchanged exercise lost its practice record")
	}
}

func TestLearningV2RejectsMalformedMetadataWithoutWriting(t *testing.T) {
	for _, key := range []string{"objectives", "prerequisites", "goal", "exercise", "practiced"} {
		for _, invalid := range []any{nil, 4, map[string]any{"unexpected": true}} {
			t.Run(key+"/"+string(mustJSON(t, invalid)), func(t *testing.T) {
				s := testStore(t)
				h := NewHandler(s)
				value := learningV2Input()
				if key == "objectives" || key == "prerequisites" {
					value[key] = invalid
				} else {
					learningV2Chapter(value)[key] = invalid
				}
				if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 400 {
					t.Fatal("malformed metadata accepted", w.Code)
				}
				if _, err := os.Stat(filepath.Join(s.root, "state", "learning.json")); !os.IsNotExist(err) {
					t.Fatal("invalid request wrote state", err)
				}
			})
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLearningV2MetadataLimitsAndExactShape(t *testing.T) {
	h := NewHandler(testStore(t))
	for _, key := range []string{"objectives", "prerequisites"} {
		for _, invalid := range []any{strings.Repeat("a", 240), []string{""}, []string{"\x00"}, []string{strings.Repeat("界", 241)}, []string{"1", "2", "3", "4", "5", "6", "7", "8", "9"}} {
			value := learningV2Input()
			value[key] = invalid
			if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 400 {
				t.Fatal("unbounded or invalid list accepted", key, w.Code)
			}
		}
	}
	for key, limit := range map[string]int{"goal": 800, "exercise": 2000} {
		for _, invalid := range []string{strings.Repeat("界", limit+1), "\x00"} {
			value := learningV2Input()
			learningV2Chapter(value)[key] = invalid
			if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 400 {
				t.Fatal("unbounded or invalid chapter text accepted", key, w.Code)
			}
		}
	}
	for _, key := range []string{"Goal", "unknownField"} {
		value := learningV2Input()
		learningV2Chapter(value)[key] = "unexpected"
		if w := apiCall(h, "POST", "/api/learning-paths", value); w.Code != 400 {
			t.Fatal("unknown or alternate-cased field accepted", key, w.Code)
		}
	}
	valid := learningV2Input()
	valid["objectives"] = []string{strings.Repeat("界", 240)}
	learningV2Chapter(valid)["goal"] = strings.Repeat("界", 800)
	learningV2Chapter(valid)["exercise"] = strings.Repeat("界", 2000)
	researchData(t, apiCall(h, "POST", "/api/learning-paths", valid))
	body := string(mustJSON(t, valid))
	request := httptest.NewRequest("POST", "/api/learning-paths", strings.NewReader(body+strings.Repeat(" ", 128<<10)))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != 413 {
		t.Fatal("metadata bypassed request budget", response.Code)
	}
}
