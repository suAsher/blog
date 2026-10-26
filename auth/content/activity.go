package content

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"
	_ "time/tzdata" // The minimal runtime image does not need OS zoneinfo files.
)

const maxActivityDays = 400

// The first and last actual write in each UTC day preserve every local calendar
// day touched in any time zone without storing one event per autosave.
type activityBucket struct {
	Date    string `json:"date"`
	FirstAt string `json:"firstAt"`
	LastAt  string `json:"lastAt"`
}

func contentLocation() (*time.Location, error) {
	name := os.Getenv("CONTENT_TIMEZONE")
	if name == "" {
		name = "Asia/Shanghai"
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("invalid CONTENT_TIMEZONE: %w", err)
	}
	return location, nil
}

func addActivity(previous []activityBucket, now time.Time) []activityBucket {
	result := append([]activityBucket{}, previous...)
	stamp := now.UTC().Format(time.RFC3339Nano)
	date := now.UTC().Format("2006-01-02")
	found := false
	for i, bucket := range result {
		if bucket.Date != date {
			continue
		}
		first, _ := time.Parse(time.RFC3339Nano, bucket.FirstAt)
		last, _ := time.Parse(time.RFC3339Nano, bucket.LastAt)
		if now.Before(first) {
			result[i].FirstAt = stamp
		}
		if now.After(last) {
			result[i].LastAt = stamp
		}
		found = true
		break
	}
	if !found {
		result = append(result, activityBucket{date, stamp, stamp})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Date < result[j].Date })
	if len(result) > maxActivityDays {
		result = append([]activityBucket{}, result[len(result)-maxActivityDays:]...)
	}
	return result
}

func validateRecordBudget(d *record) error {
	if len(d.Activity) > maxActivityDays {
		return bad(413, "写作活动记录超出大小限制。")
	}
	activity, err := json.Marshal(d.Activity)
	if err != nil || len(activity) > 48<<10 {
		return bad(413, "写作活动记录超出大小限制。")
	}
	previous := ""
	for _, bucket := range d.Activity {
		first, firstErr := time.Parse(time.RFC3339Nano, bucket.FirstAt)
		last, lastErr := time.Parse(time.RFC3339Nano, bucket.LastAt)
		if firstErr != nil || lastErr != nil || first.After(last) || first.UTC().Format("2006-01-02") != bucket.Date || last.UTC().Format("2006-01-02") != bucket.Date || bucket.Date <= previous {
			return bad(400, "写作活动记录格式无效。")
		}
		previous = bucket.Date
	}
	for _, c := range []*Content{&d.Working, d.Published} {
		if c == nil {
			continue
		}
		metadata := *c
		metadata.Source = ""
		encoded, err := json.Marshal(metadata)
		if err != nil || len(encoded) > 16<<10 {
			return bad(413, "文档元数据超出大小限制。")
		}
	}
	return nil
}
