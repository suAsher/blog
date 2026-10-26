package content

import (
	"crypto/rand"
	"math/big"
	"os"
	"sort"
	"strings"
	"time"
)

type activityDay struct {
	Date  string `json:"date"`
	Count int    `json:"count"`
}
type dashboardReview struct {
	Random    *Summary  `json:"random"`
	OnThisDay []Summary `json:"onThisDay"`
}
type dashboardStreak struct {
	Current int `json:"current"`
	Longest int `json:"longest"`
}
type DashboardData struct {
	Timezone        string          `json:"timezone"`
	Today           string          `json:"today"`
	ActivitySince   *string         `json:"activitySince"`
	HistoryComplete bool            `json:"historyComplete"`
	Activity        []activityDay   `json:"activity"`
	Streak          dashboardStreak `json:"streak"`
	Recent          []Summary       `json:"recent"`
	Drafts          []Summary       `json:"drafts"`
	Review          dashboardReview `json:"review"`
	Stats           Stats           `json:"stats"`
}

func recentFirst(a, b Summary) bool {
	if a.UpdatedAt != b.UpdatedAt {
		return a.UpdatedAt > b.UpdatedAt
	}
	return a.ID < b.ID
}

func recentSix(previous []Summary, value Summary) []Summary {
	result := append(append([]Summary{}, previous...), copySummary(value))
	sort.Slice(result, func(i, j int) bool { return recentFirst(result[i], result[j]) })
	if len(result) > 6 {
		result = result[:6]
	}
	return result
}

func (s *Store) Dashboard() (DashboardData, error) {
	now := s.now().In(s.location)
	today := now.Format("2006-01-02")
	firstDay := now.AddDate(0, 0, -365).Format("2006-01-02")
	result := DashboardData{Timezone: s.location.String(), Today: today, Activity: []activityDay{}, Recent: []Summary{}, Drafts: []Summary{}, Review: dashboardReview{OnThisDay: []Summary{}}}
	counts := map[string]int{}
	s.mu.RLock()
	defer s.mu.RUnlock()
	entries, err := os.ReadDir(s.root + "/documents")
	if err != nil {
		return result, bad(500, "今日面板暂时无法读取。")
	}
	publishedCount := int64(0)
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !strings.HasSuffix(entry.Name(), ".json") || !documentID.MatchString(id) {
			continue
		}
		d, err := s.searchRecordLocked(id, false, false)
		if err != nil {
			return result, err
		}
		switch d.status {
		case "draft":
			result.Stats.Draft++
		case "published":
			result.Stats.Published++
		case "trash":
			result.Stats.Trash++
		}
		activeDays := map[string]bool{}
		for _, bucket := range d.activity {
			for _, stamp := range []string{bucket.FirstAt, bucket.LastAt} {
				instant, err := time.Parse(time.RFC3339Nano, stamp)
				if err != nil {
					return result, bad(500, "写作活动记录异常，请检查备份。")
				}
				day := instant.In(s.location).Format("2006-01-02")
				if day <= today {
					activeDays[day] = true
				}
			}
		}
		for day := range activeDays {
			if day >= firstDay {
				counts[day]++
			}
			if result.ActivitySince == nil || day < *result.ActivitySince {
				value := day
				result.ActivitySince = &value
			}
		}
		if d.status == "trash" {
			continue
		}
		result.Recent = recentSix(result.Recent, d.working.summary)
		if d.status == "draft" {
			result.Drafts = recentSix(result.Drafts, d.working.summary)
		}
		if d.status != "published" || d.published == nil || d.published.summary.Kind == "note" {
			continue
		}
		publishedCount++
		pick, err := rand.Int(rand.Reader, big.NewInt(publishedCount))
		if err != nil {
			return result, bad(503, "暂时无法选择回顾文章。")
		}
		if pick.Int64() == 0 {
			snapshot := copySummary(d.published.summary)
			result.Review.Random = &snapshot
		}
		date, err := time.Parse("2006-01-02", d.published.summary.Date)
		if err == nil && date.Year() < now.Year() && date.Month() == now.Month() && date.Day() == now.Day() {
			result.Review.OnThisDay = recentSix(result.Review.OnThisDay, d.published.summary)
		}
	}
	run := 0
	for offset := 365; offset >= 0; offset-- {
		day := now.AddDate(0, 0, -offset).Format("2006-01-02")
		count := counts[day]
		result.Activity = append(result.Activity, activityDay{day, count})
		if count > 0 {
			run++
		} else {
			run = 0
		}
		if run > result.Streak.Longest {
			result.Streak.Longest = run
		}
	}
	start := now
	if counts[today] == 0 {
		start = now.AddDate(0, 0, -1)
	}
	for offset := 0; offset < 366; offset++ {
		if counts[start.AddDate(0, 0, -offset).Format("2006-01-02")] == 0 {
			break
		}
		result.Streak.Current++
	}
	return result, nil
}
