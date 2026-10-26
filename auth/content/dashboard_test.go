package content

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDashboardFreshEmptyAndMethod(t *testing.T) {
	h := NewHandler(testStore(t))
	w := apiCall(h, "GET", "/api/dashboard", nil)
	if w.Code != 200 {
		t.Fatalf("dashboard unavailable: %s", w.Body.String())
	}
	d := metadataResult(t, w)
	if d["timezone"] != "Asia/Shanghai" || d["historyComplete"] != false || d["activitySince"] != nil || len(d["activity"].([]any)) != 366 {
		t.Fatal("empty dashboard contract", d)
	}
	for _, field := range []string{"recent", "drafts"} {
		if len(d[field].([]any)) != 0 {
			t.Fatal("empty dashboard has fake content")
		}
	}
	if apiCall(h, "POST", "/api/dashboard", nil).Code != 405 {
		t.Fatal("dashboard accepts mutation")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private dashboard cacheable")
	}
}

func TestActivityBoundsAndSubsecondOrder(t *testing.T) {
	start := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	buckets := addActivity(nil, start)
	buckets = addActivity(buckets, start.Add(500*time.Millisecond))
	if buckets[0].FirstAt != start.Format(time.RFC3339Nano) || buckets[0].LastAt != start.Add(500*time.Millisecond).Format(time.RFC3339Nano) {
		t.Fatal("subsecond timestamps sorted as strings")
	}
	for day := 1; day < 450; day++ {
		buckets = addActivity(buckets, start.AddDate(0, 0, day))
	}
	if len(buckets) != 400 || buckets[0].Date != start.AddDate(0, 0, 50).Format("2006-01-02") {
		t.Fatal("activity not bounded to latest400 UTC buckets")
	}
	copyOf := append([]activityBucket{}, buckets...)
	_ = addActivity(buckets, start.AddDate(0, 0, 500))
	if buckets[0] != copyOf[0] || buckets[len(buckets)-1] != copyOf[len(copyOf)-1] {
		t.Fatal("activity helper mutated caller slice")
	}
}

func TestDashboardTimezoneStreakNoopAndLifecycleActivity(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 24, 15, 59, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	c := input("body")
	c.Date = "2025-10-25"
	d := mustCreate(t, s, c)
	now = now.Add(2 * time.Minute) // Same UTC day, next calendar day in Shanghai.
	d, err := s.Update(d.ID, input("second write"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Streak.Current != 2 || result.Streak.Longest != 2 || result.Activity[len(result.Activity)-1].Count != 1 {
		t.Fatalf("timezone/streak incorrect: %#v", result.Streak)
	}
	d, _ = s.Action(d.ID, "publish", d.Version)
	now = now.AddDate(0, 0, 1)
	d, _ = s.Action(d.ID, "unpublish", d.Version)
	d, _ = s.Action(d.ID, "publish", d.Version)
	// Exact same content produces no new writing day.
	d, err = s.Update(d.ID, input("second write"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	result, err = s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Activity[len(result.Activity)-1].Count != 0 || result.Streak.Current != 2 {
		t.Fatal("lifecycle/noop autosave invented activity")
	}
	if result.Review.Random == nil || result.Review.Random.Title != "真实文档" {
		t.Fatal("published review missing")
	}
	result.Recent[0].Tags[0] = "caller mutation"
	result.Review.Random.Tags[0] = "caller mutation"
	result, err = s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Recent[0].Tags[0] == "caller mutation" || result.Review.Random.Tags[0] == "caller mutation" {
		t.Fatal("dashboard exposed mutable cache slices")
	}
}

func TestDashboardRecentBoundOnThisDayAndNoLegacyHistory(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	for i := 0; i < 9; i++ {
		c := input("body")
		c.Date = "2025-10-26"
		d := mustCreate(t, s, c)
		if i == 0 {
			_, _ = s.Action(d.ID, "publish", d.Version)
		}
		now = now.Add(time.Minute)
	}
	result, err := s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Recent) != 6 || len(result.Drafts) != 6 || len(result.Review.OnThisDay) != 1 || result.Stats.Draft != 8 {
		t.Fatal("dashboard list budget/anniversary failed")
	}
	entries, _ := os.ReadDir(filepath.Join(s.root, "documents"))
	for _, entry := range entries {
		name := filepath.Join(s.root, "documents", entry.Name())
		data, _ := os.ReadFile(name)
		var value map[string]any
		_ = json.Unmarshal(data, &value)
		delete(value, "activity")
		value["createdAt"] = "2020-01-01T00:00:00Z"
		value["updatedAt"] = "2026-10-26T00:00:00Z"
		data, _ = json.Marshal(value)
		if err := os.WriteFile(name, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	result, err = s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.ActivitySince != nil || result.Streak.Current != 0 {
		t.Fatal("legacy createdAt/updatedAt fabricated history")
	}
}

func TestDashboardRejectsCorruptDocumentsAndActivity(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	name := filepath.Join(s.root, "documents", d.ID+".json")
	bytes, _ := os.ReadFile(name)
	var value map[string]any
	_ = json.Unmarshal(bytes, &value)
	value["activity"] = []map[string]string{{"date": "2026-10-26", "firstAt": "bad", "lastAt": "bad"}}
	bytes, _ = json.Marshal(value)
	_ = os.WriteFile(name, bytes, 0600)
	if _, err := s.Dashboard(); err == nil {
		t.Fatal("malformed activity hidden")
	}
	_ = os.WriteFile(name, []byte(strings.Repeat("x", 10)), 0600)
	if _, err := s.Dashboard(); err == nil {
		t.Fatal("corrupt document ignored")
	}
}

func TestFailedWriteDoesNotPersistActivity(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	d := mustCreate(t, s, input("first day"))
	now = now.AddDate(0, 0, 1)
	s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
	if _, err := s.Update(d.ID, input("not saved"), d.Version); err == nil {
		t.Fatal("write unexpectedly succeeded")
	}
	result, err := s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Activity[len(result.Activity)-1].Count != 0 {
		t.Fatal("failed edit created activity")
	}
	live, err := s.Get(d.ID, "")
	if err != nil || live.Source != "first day" {
		t.Fatal("failed edit replaced durable document")
	}
}

func TestMetadataOnlyAndBlankBodyUpdatesDoNotCountWriting(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	c := input("existing body")
	d := mustCreate(t, s, c)
	now = now.AddDate(0, 0, 1)
	c.Title = "renamed title"
	c.Tags = []string{"new tag"}
	c.Series = "new series"
	c.Maturity = "growing"
	d, err := s.Update(d.ID, c, d.Version)
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Activity[len(result.Activity)-1].Count != 0 {
		t.Fatal("metadata-only edit counted as writing")
	}
	c.Source = " \n\t"
	if _, err := s.Update(d.ID, c, d.Version); err != nil {
		t.Fatal(err)
	}
	result, err = s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Activity[len(result.Activity)-1].Count != 0 {
		t.Fatal("blank body counted as writing")
	}
}

func TestDailyReviewExcludesPublishedNotes(t *testing.T) {
	s := testStore(t)
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	c := input("note body")
	c.Kind = "note"
	c.Date = "2025-10-26"
	d := mustCreate(t, s, c)
	if _, err := s.Action(d.ID, "publish", d.Version); err != nil {
		t.Fatal(err)
	}
	result, err := s.Dashboard()
	if err != nil {
		t.Fatal(err)
	}
	if result.Review.Random != nil || len(result.Review.OnThisDay) != 0 {
		t.Fatal("daily article review selected a note")
	}
	c.Kind = "article"
	c.Title = "review article"
	d = mustCreate(t, s, c)
	if _, err := s.Action(d.ID, "publish", d.Version); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		result, err = s.Dashboard()
		if err != nil {
			t.Fatal(err)
		}
		if result.Review.Random == nil || result.Review.Random.ID != d.ID || len(result.Review.OnThisDay) != 1 || result.Review.OnThisDay[0].ID != d.ID {
			t.Fatal("published note leaked into review selection")
		}
	}
}

func TestDashboardCountsRealWritesAndKeepsPublicationIsolated(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	empty := mustCreate(t, s, input(""))
	d := mustCreate(t, s, input("written body"))
	d, _ = s.Action(d.ID, "publish", d.Version)
	changed := input("unpublished secret")
	changed.Title = "unpublished title"
	d, err := s.Update(d.ID, changed, d.Version)
	if err != nil {
		t.Fatal(err)
	}
	result := metadataResult(t, apiCall(h, "GET", "/api/dashboard", nil))
	activity := result["activity"].([]any)
	last := activity[len(activity)-1].(map[string]any)
	if last["count"] != float64(1) {
		t.Fatalf("not one active document: %#v", last)
	}
	if result["activitySince"] != result["today"] {
		t.Fatal("activity did not start with real write")
	}
	review := result["review"].(map[string]any)
	if review["random"].(map[string]any)["title"] != "真实文档" {
		t.Fatal("working title leaked into reading review")
	}
	name := filepath.Join(s.root, "documents", empty.ID+".json")
	bytes, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	_ = json.Unmarshal(bytes, &record)
	if activity, ok := record["activity"].([]any); ok && len(activity) > 0 {
		t.Fatal("empty create fabricated writing activity")
	}
	name = filepath.Join(s.root, "documents", d.ID+".json")
	bytes, _ = os.ReadFile(name)
	_ = json.Unmarshal(bytes, &record)
	if len(record["activity"].([]any)) != 1 {
		t.Fatal("same UTC day not compacted")
	}
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	result = metadataResult(t, apiCall(NewHandler(reopened), "GET", "/api/dashboard", nil))
	if result["activitySince"] == nil {
		t.Fatal("activity lost after restart")
	}
}

func TestDashboardTimezoneValidation(t *testing.T) {
	t.Setenv("CONTENT_TIMEZONE", "Etc/DefinitelyInvalid")
	if _, err := NewStore(t.TempDir()); err == nil {
		t.Fatal("invalid timezone silently accepted")
	}
	t.Setenv("CONTENT_TIMEZONE", "UTC")
	s := testStore(t)
	d := metadataResult(t, apiCall(NewHandler(s), "GET", "/api/dashboard", nil))
	if d["timezone"] != "UTC" || d["today"] != time.Now().UTC().Format("2006-01-02") {
		t.Fatal("configured timezone ignored")
	}
}
