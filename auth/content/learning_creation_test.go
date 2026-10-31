package content

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestLearningCreationRetryAndImmutableKey(t *testing.T) {
	h := NewHandler(testStore(t))
	value := learningV2Input()
	value["creationKey"] = "import-0123456789abcdef0123456789abcdef"
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	retried := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	if !reflect.DeepEqual(created, retried) {
		t.Fatal("lost response retry changed route or version")
	}
	path := "/api/learning-paths/" + created["id"].(string)
	update := learningInput()
	update["version"] = 1
	updated := researchData(t, apiCall(h, "PUT", path, update))
	if updated["creationKey"] != value["creationKey"] {
		t.Fatal("old client erased creation key")
	}
	for _, changed := range []string{"", "different-key"} {
		update["version"] = 2
		update["creationKey"] = changed
		if response := apiCall(h, "PUT", path, update); response.Code != 400 {
			t.Fatal("immutable key changed", response.Code)
		}
	}
	update["creationKey"] = value["creationKey"]
	researchData(t, apiCall(h, "PUT", path, update))
	value["title"] = "另一个编排"
	if response := apiCall(h, "POST", "/api/learning-paths", value); response.Code != 409 || !strings.Contains(response.Body.String(), "CREATION_CONFLICT") {
		t.Fatal("same key silently accepted a different plan", response.Code, response.Body.String())
	}
	listed := researchData(t, apiCall(h, "GET", "/api/learning-paths", nil))
	if len(listed["paths"].([]any)) != 1 {
		t.Fatal("retry created another route")
	}
}

func TestLearningCreationCanonicalOptionalDefaults(t *testing.T) {
	h := NewHandler(testStore(t))
	value := learningInput()
	value["creationKey"] = "import-empty-optionals"
	created := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	value["objectives"] = []string{}
	value["prerequisites"] = []string{}
	chapter := learningV2Chapter(value)
	chapter["goal"], chapter["exercise"], chapter["practiced"] = "", "", false
	retried := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	if created["id"] != retried["id"] || retried["version"] != float64(1) {
		t.Fatal("equivalent optional defaults were not idempotent", retried)
	}
	// Recovery must continue to work when a user has since reached the route cap.
	for i := 0; i < 49; i++ {
		researchData(t, apiCall(h, "POST", "/api/learning-paths", learningInput()))
	}
	retried = researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	if retried["id"] != created["id"] {
		t.Fatal("capacity check blocked recovery")
	}
}

func TestLearningCreationConcurrentRetryCreatesOneRoute(t *testing.T) {
	h := NewHandler(testStore(t))
	var wait sync.WaitGroup
	ids := make(chan string, 6)
	codes := make(chan int, 6)
	for i := 0; i < 6; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value := learningV2Input()
			value["creationKey"] = "import-concurrent"
			response := apiCall(h, "POST", "/api/learning-paths", value)
			codes <- response.Code
			var result struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if json.Unmarshal(response.Body.Bytes(), &result) == nil {
				ids <- result.Data.ID
			}
		}()
	}
	wait.Wait()
	close(ids)
	close(codes)
	for code := range codes {
		if code != 201 {
			t.Fatal("concurrent retry failed", code)
		}
	}
	unique := map[string]bool{}
	for id := range ids {
		if id == "" {
			t.Fatal("missing recovered route ID")
		}
		unique[id] = true
	}
	if len(unique) != 1 {
		t.Fatal("concurrent imports created duplicate routes", unique)
	}
}

func TestLearningCreationRejectsMalformedAndStoredDuplicateKeys(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	for _, key := range []any{nil, 1, "", "../outside", strings.Repeat("x", 81)} {
		value := learningInput()
		value["creationKey"] = key
		if response := apiCall(h, "POST", "/api/learning-paths", value); response.Code != 400 {
			t.Fatal("invalid creation key accepted", key, response.Code)
		}
	}
	value := learningInput()
	value["creationKey"] = "import-safe"
	first := researchData(t, apiCall(h, "POST", "/api/learning-paths", value))
	file := filepath.Join(s.root, "state", "learning.json")
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var state learningFile
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	copy := state.Paths[first["id"].(string)]
	copy.ID = strings.Repeat("f", 32)
	state.Paths[copy.ID] = copy
	if err := os.WriteFile(file, mustJSON(t, state), 0600); err != nil {
		t.Fatal(err)
	}
	if response := apiCall(h, "GET", "/api/learning-paths", nil); response.Code != 500 {
		t.Fatal("ambiguous stored idempotency keys accepted", response.Code)
	}
}
