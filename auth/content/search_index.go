package content

import (
	"container/list"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
)

const searchCacheBudget int64 = 16 << 20
const maxRecordBytes = MaxSourceBytes*5 + (192 << 10)

type searchView struct {
	summary                        Summary
	source                         string
	title, description, tags, body string
	ready                          bool
}
type searchRecord struct {
	status             string
	working, published *searchView
	activity           []activityBucket
}
type searchEntry struct {
	id    string
	info  os.FileInfo
	value searchRecord
	size  int64
}

// Search entries are immutable after publication. Readers may use a returned
// entry after releasing this mutex while another request replaces its LRU slot.
// Store.mu is always acquired before this mutex; the cache never acquires it.
type searchCache struct {
	mu           sync.Mutex
	entries      map[string]*list.Element
	order        *list.List
	bytes, limit int64
}

func newSearchCache(limit int64) *searchCache {
	return &searchCache{entries: map[string]*list.Element{}, order: list.New(), limit: limit}
}
func (c *searchCache) remove(element *list.Element) {
	entry := element.Value.(searchEntry)
	c.bytes -= entry.size
	delete(c.entries, entry.id)
	c.order.Remove(element)
}
func (c *searchCache) invalidate(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if element := c.entries[id]; element != nil {
		c.remove(element)
	}
}

// Changed bytes, permissions, ownership, replacement inodes and restored mtimes
// all invalidate an entry. Ctime's field name differs on Linux and Darwin.
func changeTime(info os.FileInfo) [2]int64 {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() != reflect.Pointer || value.IsNil() {
		return [2]int64{}
	}
	value = value.Elem()
	if value.Kind() != reflect.Struct {
		return [2]int64{}
	}
	for _, name := range []string{"Ctim", "Ctimespec"} {
		stamp := value.FieldByName(name)
		if stamp.IsValid() && stamp.Kind() == reflect.Struct {
			seconds, nanos := stamp.FieldByName("Sec"), stamp.FieldByName("Nsec")
			if seconds.IsValid() && nanos.IsValid() && seconds.CanInt() && nanos.CanInt() {
				return [2]int64{seconds.Int(), nanos.Int()}
			}
		}
	}
	return [2]int64{}
}
func sameSearchFile(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.Mode() == b.Mode() && a.ModTime() == b.ModTime() && changeTime(a) == changeTime(b)
}
func searchable(view *searchView) *searchView {
	if view == nil || view.ready {
		return view
	}
	result := *view
	result.title = normalized(view.summary.Title)
	result.description = normalized(view.summary.Description)
	result.tags = normalized(strings.Join(append(append([]string{}, view.summary.Tags...), view.summary.Series, view.summary.Kind, view.summary.Maturity), " "))
	result.body = normalized(view.source)
	result.ready = true
	return &result
}
func (r searchRecord) prepare(published bool) searchRecord {
	result := r
	if published {
		result.published = searchable(r.published)
	} else {
		result.working = searchable(r.working)
	}
	if r.working == r.published {
		if published {
			result.working = result.published
		} else {
			result.published = result.working
		}
	}
	return result
}
func viewBytes(view *searchView) int64 {
	if view == nil {
		return 0
	}
	// Include string/slice headers, map/list bookkeeping and generous fixed
	// metadata overhead rather than charging only the normalized Markdown bytes.
	total := int64(1024 + len(view.source) + len(view.title) + len(view.description) + len(view.tags) + len(view.body))
	metadata := view.summary
	for _, text := range []string{metadata.ID, metadata.Title, metadata.Description, metadata.Date, metadata.Category, metadata.Cover, metadata.CreatedAt, metadata.UpdatedAt, metadata.PublishedAt, metadata.Kind, metadata.Maturity, metadata.Series} {
		total += int64(len(text))
	}
	for _, tag := range metadata.Tags {
		total += int64(16 + len(tag))
	}
	for _, id := range metadata.Related {
		total += int64(16 + len(id))
	}
	return total
}
func recordBytes(value searchRecord) int64 {
	total := int64(512) + viewBytes(value.working)
	for _, bucket := range value.activity {
		total += int64(80 + len(bucket.Date) + len(bucket.FirstAt) + len(bucket.LastAt))
	}
	if value.published != value.working {
		total += viewBytes(value.published)
	}
	return total
}
func (c *searchCache) get(id string, info os.FileInfo, published, query bool, load func() (searchRecord, error)) (searchRecord, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var value searchRecord
	if element := c.entries[id]; element != nil {
		entry := element.Value.(searchEntry)
		if sameSearchFile(entry.info, info) {
			value = entry.value
			c.order.MoveToFront(element)
		} else {
			c.remove(element)
		}
	}
	if value.working == nil {
		loaded, err := load()
		if err != nil {
			return searchRecord{}, err
		}
		value = loaded
	}
	if query {
		value = value.prepare(published)
	}
	size := recordBytes(value)
	if size > c.limit {
		return value, nil
	}
	if element := c.entries[id]; element != nil {
		c.remove(element)
	}
	for c.bytes+size > c.limit && c.order.Len() > 0 {
		c.remove(c.order.Back())
	}
	element := c.order.PushFront(searchEntry{id: id, info: info, value: value, size: size})
	c.entries[id] = element
	c.bytes += size
	return value, nil
}
func indexRecord(d *record) searchRecord {
	working := &searchView{summary: summary(d, d.Working), source: d.Working.Source}
	result := searchRecord{status: d.Status, working: working, activity: append([]activityBucket{}, d.Activity...)}
	if d.Published != nil {
		if sameContent(d.Working, *d.Published) {
			result.published = working
		} else {
			result.published = &searchView{summary: summary(d, *d.Published), source: d.Published.Source}
		}
	}
	return result
}
func readSearchRecord(name, id string, expected os.FileInfo) (searchRecord, error) {
	// Reject a leaf symlink even if it was swapped in between Lstat and Open.
	file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return searchRecord{}, bad(500, "文档暂时无法读取，请稍后重试。")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !sameSearchFile(expected, before) {
		return searchRecord{}, bad(500, "文档读取期间发生变化，请重试。")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxRecordBytes+1))
	if err != nil || int64(len(data)) > maxRecordBytes {
		return searchRecord{}, bad(500, "文档暂时无法读取，请稍后重试。")
	}
	after, err := file.Stat()
	if err != nil || !sameSearchFile(before, after) {
		return searchRecord{}, bad(500, "文档读取期间发生变化，请重试。")
	}
	var d record
	if json.Unmarshal(data, &d) != nil || d.ID != id || d.Version < 1 {
		return searchRecord{}, bad(500, "文档记录异常，请从备份恢复。")
	}
	if err := validateStoredRecord(&d); err != nil {
		return searchRecord{}, bad(500, "文档记录超出安全读取预算，请检查备份。")
	}
	return indexRecord(&d), nil
}
func (s *Store) searchRecordLocked(id string, published, query bool) (searchRecord, error) {
	name := filepath.Join(s.root, "documents", id+".json")
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
		return searchRecord{}, bad(500, "文档暂时无法读取，请稍后重试。")
	}
	return s.search.get(id, info, published, query, func() (searchRecord, error) { return readSearchRecord(name, id, info) })
}
func (view *searchView) matches(tokens []string) (int, bool) {
	score := 0
	for _, token := range tokens {
		inTitle, inDescription := strings.Contains(view.title, token), strings.Contains(view.description, token)
		if !inTitle && !inDescription && !strings.Contains(view.tags, token) && !strings.Contains(view.body, token) {
			return 0, false
		}
		if inTitle {
			score += 10
		}
		if inDescription {
			score += 3
		}
	}
	return score, true
}
