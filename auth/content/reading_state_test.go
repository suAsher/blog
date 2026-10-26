package content

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func readingOperationInput(n int, key string, base, patch map[string]any) map[string]any {
	return map[string]any{"opId": fmt.Sprintf("%08x-0000-4000-8000-%012x", n, n), "key": key, "base": base, "patch": patch}
}
func readingPost(t *testing.T, s *Store, operations ...map[string]any) map[string]any {
	t.Helper()
	w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": operations})
	if w.Code != 200 {
		t.Fatalf("reading operation failed %d: %s", w.Code, w.Body.String())
	}
	return metadataResult(t, w)
}

func TestReadingStateMigrationCASAndPersistence(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	w := apiCall(h, "GET", "/api/reading-state", nil)
	if w.Code != 200 {
		t.Fatalf("reading state unavailable: %s", w.Body.String())
	}
	empty := metadataResult(t, w)
	if empty["revision"] != float64(0) || len(empty["entries"].(map[string]any)) != 0 {
		t.Fatal("empty state is not canonical")
	}
	op := readingOperationInput(1, "legacy-note", map[string]any{"bookmarked": 0, "read": 0, "progress": 0}, map[string]any{"bookmarked": true, "read": false, "progress": 42})
	response := readingPost(t, s, op)
	result := response["results"].([]any)[0].(map[string]any)
	entry := result["entry"].(map[string]any)
	if len(result["applied"].([]any)) != 3 || entry["bookmarked"] != true || entry["progress"] != float64(42) || response["revision"] != float64(1) {
		t.Fatal(response)
	}
	// An old device's migration must not overwrite the newer server bookmark,
	// while an unrelated first-time review field may be accepted independently.
	conflict := readingOperationInput(2, "legacy-note", map[string]any{"bookmarked": 0, "review": 0}, map[string]any{"bookmarked": false, "reviewAction": "enable"})
	response = readingPost(t, s, conflict)
	result = response["results"].([]any)[0].(map[string]any)
	entry = result["entry"].(map[string]any)
	if entry["bookmarked"] != true || len(result["conflicts"].([]any)) != 1 || len(result["applied"].([]any)) != 1 {
		t.Fatal("independent CAS merge failed", response)
	}
	name := filepath.Join(s.root, "state", "reading.json")
	info, err := os.Stat(name)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("state is not private0600", err)
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	durable := metadataResult(t, apiCall(NewHandler(reopened), "GET", "/api/reading-state", nil))
	if durable["revision"] != response["revision"] || len(durable["entries"].(map[string]any)) != 1 {
		t.Fatal("state not durable across restart")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private reading state cacheable")
	}
}

func TestReadingOperationReceiptsBindPayloadAndRemainIdempotent(t *testing.T) {
	s := testStore(t)
	op := readingOperationInput(1, "note", map[string]any{"progress": 0}, map[string]any{"progress": 12})
	first := readingPost(t, s, op)
	replayed := readingPost(t, s, op)
	if first["revision"] != replayed["revision"] {
		t.Fatal("retry applied operation twice")
	}
	op["patch"] = map[string]any{"progress": 99}
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{op}}); w.Code != 409 || !strings.Contains(w.Body.String(), "OP_ID_REUSE") {
		t.Fatal("same operation ID accepted a different payload", w.Body.String())
	}
	op = readingOperationInput(2, "note", map[string]any{"bookmarked": 0}, map[string]any{"bookmarked": true})
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{op, op}}); w.Code != 400 {
		t.Fatal("duplicate batch operation accepted")
	}
}

func TestReadingBatchPrevalidationAndDiskFailureAreAtomic(t *testing.T) {
	s := testStore(t)
	valid := readingOperationInput(1, "note", map[string]any{"bookmarked": 0}, map[string]any{"bookmarked": true})
	invalid := readingOperationInput(2, "other", map[string]any{"progress": 0}, map[string]any{"progress": 101})
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{valid, invalid}}); w.Code != 400 {
		t.Fatal("invalid batch accepted")
	}
	reading := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reading-state", nil))
	if reading["revision"] != float64(0) {
		t.Fatal("batch partially applied before validation")
	}
	s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{valid}}); w.Code != 507 {
		t.Fatal("low disk state write accepted", w.Body.String())
	}
	reading = metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reading-state", nil))
	if reading["revision"] != float64(0) || len(reading["entries"].(map[string]any)) != 0 {
		t.Fatal("failed disk save changed authoritative state")
	}
}

func TestReadingConcurrentSameFieldHasOneWinner(t *testing.T) {
	s := testStore(t)
	var group sync.WaitGroup
	results := make(chan map[string]any, 2)
	for i := 1; i <= 2; i++ {
		group.Add(1)
		go func(n int) {
			defer group.Done()
			op := readingOperationInput(n, "note", map[string]any{"bookmarked": 0}, map[string]any{"bookmarked": n == 1})
			w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{op}})
			var value struct {
				Data map[string]any `json:"data"`
			}
			_ = json.Unmarshal(w.Body.Bytes(), &value)
			results <- value.Data
		}(i)
	}
	group.Wait()
	close(results)
	applied, conflicts := 0, 0
	for response := range results {
		if response == nil {
			t.Fatal("concurrent request failed")
		}
		result := response["results"].([]any)[0].(map[string]any)
		applied += len(result["applied"].([]any))
		conflicts += len(result["conflicts"].([]any))
	}
	if applied != 1 || conflicts != 1 {
		t.Fatal("concurrent CAS lost write isolation", applied, conflicts)
	}
}

func TestReviewScheduleUsesServerClockAndProgressiveIntervals(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	response := readingPost(t, s, readingOperationInput(1, "review-note", map[string]any{"review": 0}, map[string]any{"reviewAction": "enable"}))
	entry := response["results"].([]any)[0].(map[string]any)["entry"].(map[string]any)
	review := entry["review"].(map[string]any)
	if review["dueAt"] != now.Add(24*time.Hour).Format(time.RFC3339Nano) || review["step"] != float64(0) {
		t.Fatal("first interval not1day", review)
	}
	for i, days := range []int{3, 7, 30, 30} {
		now = now.Add(40 * 24 * time.Hour)
		base := entry["fieldRevisions"].(map[string]any)["review"]
		response = readingPost(t, s, readingOperationInput(i+2, "review-note", map[string]any{"review": base}, map[string]any{"reviewAction": "complete"}))
		entry = response["results"].([]any)[0].(map[string]any)["entry"].(map[string]any)
		review = entry["review"].(map[string]any)
		if review["dueAt"] != now.Add(time.Duration(days)*24*time.Hour).Format(time.RFC3339Nano) || review["lastReviewedAt"] != now.Format(time.RFC3339Nano) {
			t.Fatal("server review interval incorrect", review)
		}
	}
	now = now.Add(31 * 24 * time.Hour)
	due := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reviews?limit=20", nil))
	if due["total"] != float64(1) || len(due["due"].([]any)) != 1 {
		t.Fatal("due review missing", due)
	}
	response = readingPost(t, s, readingOperationInput(9, "review-note", map[string]any{"review": entry["fieldRevisions"].(map[string]any)["review"]}, map[string]any{"reviewAction": "disable"}))
	review = response["results"].([]any)[0].(map[string]any)["entry"].(map[string]any)["review"].(map[string]any)
	if review["enabled"] != false || review["dueAt"] != nil {
		t.Fatal("review disable did not clear due date")
	}
}

func TestReadingReceiptsSurviveRestartAndReplayCurrentCanonicalState(t *testing.T) {
	s := testStore(t)
	first := readingOperationInput(1, "note", map[string]any{"progress": 0}, map[string]any{"progress": 12})
	response := readingPost(t, s, first)
	readingPost(t, s, readingOperationInput(2, "note", map[string]any{"progress": response["revision"]}, map[string]any{"progress": 88}))
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	response = readingPost(t, reopened, first)
	result := response["results"].([]any)[0].(map[string]any)
	if result["replayed"] != true || result["entry"].(map[string]any)["progress"] != float64(88) || response["revision"] != float64(2) {
		t.Fatal("replay returned stale entry or reapplied", response)
	}
}

func TestReadingReceiptWindowAndEvictedReplayStillUsesCAS(t *testing.T) {
	s := testStore(t)
	first := readingOperationInput(1, "note", map[string]any{"progress": 0}, map[string]any{"progress": 1})
	readingPost(t, s, first)
	revision := 1
	for start := 2; start <= 258; start += 32 {
		batch := []map[string]any{}
		for n := start; n < start+32 && n <= 258; n++ {
			batch = append(batch, readingOperationInput(n, "note", map[string]any{"progress": revision}, map[string]any{"progress": n % 101}))
			revision++
		}
		readingPost(t, s, batch...)
	}
	s.mu.RLock()
	stored, err := s.loadReadingLocked()
	s.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Receipts) != 256 || stored.Receipts[0].OpID == first["opId"] {
		t.Fatal("receipt window is unbounded")
	}
	response := readingPost(t, s, first)
	result := response["results"].([]any)[0].(map[string]any)
	if len(result["applied"].([]any)) != 0 || len(result["conflicts"].([]any)) != 1 || response["revision"] != float64(258) {
		t.Fatal("evicted receipt bypassed field CAS", response)
	}
}

func TestReadingDomainFailureRollsBackEntireBatchAndPureConflictsDoNotBump(t *testing.T) {
	s := testStore(t)
	valid := readingOperationInput(1, "note", map[string]any{"read": 0}, map[string]any{"read": true})
	complete := readingOperationInput(2, "other", map[string]any{"review": 0}, map[string]any{"reviewAction": "complete"})
	if w := apiCall(NewHandler(s), "POST", "/api/reading-state", map[string]any{"operations": []any{valid, complete}}); w.Code != 409 || !strings.Contains(w.Body.String(), "REVIEW_DISABLED") {
		t.Fatal("disabled review completion not explicit", w.Body.String())
	}
	state := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reading-state", nil))
	if state["revision"] != float64(0) || len(state["entries"].(map[string]any)) != 0 {
		t.Fatal("domain failure partially persisted batch")
	}
	response := readingPost(t, s, readingOperationInput(3, "note", map[string]any{"read": 99}, map[string]any{"read": true}))
	if response["revision"] != float64(0) {
		t.Fatal("pure conflict bumped revision")
	}
	state = metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reading-state", nil))
	if len(state["entries"].(map[string]any)) != 0 {
		t.Fatal("pure conflict created fabricated entry")
	}
}

func TestDueReviewResponseIsOrderedBoundedAndFresh(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	readingPost(t, s, readingOperationInput(1, "b", map[string]any{"review": 0}, map[string]any{"reviewAction": "enable"}), readingOperationInput(2, "a", map[string]any{"review": 0}, map[string]any{"reviewAction": "enable"}))
	due := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reviews?limit=1", nil))
	if due["total"] != float64(0) {
		t.Fatal("future review returned as due")
	}
	now = now.Add(25 * time.Hour)
	due = metadataResult(t, apiCall(NewHandler(s), "GET", "/api/reviews?limit=1", nil))
	if due["total"] != float64(2) || len(due["due"].([]any)) != 1 || due["due"].([]any)[0].(map[string]any)["key"] != "a" {
		t.Fatal("review pagination/order failed", due)
	}
	state, err := s.ReadingState()
	if err != nil {
		t.Fatal(err)
	}
	entry := state.Entries["a"]
	entry.Progress = 99
	*entry.Review.DueAt = "caller corruption"
	state.Entries["a"] = entry
	state, err = s.ReadingState()
	if err != nil || state.Entries["a"].Progress != 0 || *state.Entries["a"].Review.DueAt == "caller corruption" {
		t.Fatal("getter leaked mutable authoritative state")
	}
}
