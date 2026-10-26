package content

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWarmSearchAvoidsRepeatedDocumentDecoding(t *testing.T) {
	s := testStore(t)
	for i := 0; i < 5; i++ {
		c := input(strings.Repeat("ordinary source content ", 5500))
		c.Title = fmt.Sprintf("Cache fixture %d", i)
		d := mustCreate(t, s, c)
		if _, err := s.Action(d.ID, "publish", d.Version); err != nil {
			t.Fatal(err)
		}
	}
	options := ListOptions{Query: "absent-token"}
	if _, err := s.List(options); err != nil {
		t.Fatal(err)
	}
	result := testing.Benchmark(func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			if _, err := s.List(options); err != nil {
				b.Fatal(err)
			}
		}
	})
	t.Logf("warm allocations: %d bytes/op", result.AllocedBytesPerOp())
	if result.AllocedBytesPerOp() > 128<<10 {
		t.Fatalf("warm query should reuse bounded derived data, allocated %d bytes per operation", result.AllocedBytesPerOp())
	}
}

func TestSearchCacheWarmLoadsAndLazyNormalization(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("mixed FULLWIDTHＡ source"))
	name := filepath.Join(s.root, "documents", d.ID+".json")
	info, _ := os.Lstat(name)
	cache := newSearchCache(1 << 20)
	reads := 0
	load := func() (searchRecord, error) { reads++; return readSearchRecord(name, d.ID, info) }
	first, err := cache.get(d.ID, info, false, false, load)
	if err != nil || first.working.ready {
		t.Fatal("unqueried text should not be normalized")
	}
	second, err := cache.get(d.ID, info, false, true, load)
	if err != nil || !second.working.ready || reads != 1 {
		t.Fatalf("warm search decoded again: %d", reads)
	}
	if first.working.ready {
		t.Fatal("normalization mutated an entry held by another reader")
	}
	if _, ok := second.working.matches([]string{"fullwidtha"}); !ok {
		t.Fatal("width/case normalization")
	}
}

func TestSearchCacheSnapshotMutationsAndCallerIsolation(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("old snapshot token"))
	d, _ = s.Action(d.ID, "publish", d.Version)
	find := func(status, query string, want int) {
		t.Helper()
		r, e := s.List(ListOptions{Status: status, Query: query})
		if e != nil || r.Total != want {
			t.Fatalf("%s/%s: count=%d err=%v", status, query, r.Total, e)
		}
	}
	find("published", "old snapshot", 1)
	d, _ = s.Update(d.ID, input("unpublished change"), d.Version)
	find("published", "old snapshot", 1)
	find("published", "unpublished", 0)
	find("all", "unpublished", 1)
	r, _ := s.List(ListOptions{Status: "all"})
	r.Documents[0].Tags[0] = "caller mutation"
	r, _ = s.List(ListOptions{Status: "all"})
	if r.Documents[0].Tags[0] != "测试标签" {
		t.Fatal("caller poisoned cache")
	}
	d, _ = s.Action(d.ID, "publish", d.Version)
	find("published", "old snapshot", 0)
	find("published", "unpublished", 1)
	d, _ = s.Action(d.ID, "unpublish", d.Version)
	find("published", "unpublished", 0)
	find("draft", "unpublished", 1)
	d, _ = s.Action(d.ID, "publish", d.Version)
	find("published", "unpublished", 1)
	d, _ = s.Action(d.ID, "trash", d.Version)
	find("published", "unpublished", 0)
	find("trash", "unpublished", 1)
	d, _ = s.Action(d.ID, "restore", d.Version)
	find("draft", "unpublished", 1)
	find("published", "unpublished", 0)
	d, _ = s.Action(d.ID, "trash", d.Version)
	if err := s.Delete(d.ID, d.Version); err != nil {
		t.Fatal(err)
	}
	find("trash", "unpublished", 0)
	if len(s.search.entries) != 0 {
		t.Fatal("deleted entry retained")
	}
}

func TestSearchCacheEvictionOversizeAndReadFailures(t *testing.T) {
	s := testStore(t)
	a := mustCreate(t, s, input("first value"))
	b := mustCreate(t, s, input("second value"))
	info, _ := os.Lstat(filepath.Join(s.root, "documents", a.ID+".json"))
	one, err := readSearchRecord(filepath.Join(s.root, "documents", a.ID+".json"), a.ID, info)
	if err != nil {
		t.Fatal(err)
	}
	cache := newSearchCache(recordBytes(one) + 50)
	reads := 0
	get := func(id string) searchRecord {
		t.Helper()
		name := filepath.Join(s.root, "documents", id+".json")
		stat, _ := os.Lstat(name)
		value, e := cache.get(id, stat, false, false, func() (searchRecord, error) { reads++; return readSearchRecord(name, id, stat) })
		if e != nil {
			t.Fatal(e)
		}
		return value
	}
	get(a.ID)
	get(b.ID)
	if cache.bytes > cache.limit || len(cache.entries) != 1 {
		t.Fatal("cache budget or eviction incorrect")
	}
	get(a.ID)
	if reads != 3 {
		t.Fatal("evicted data unexpectedly retained")
	}
	tiny := newSearchCache(1)
	_, err = tiny.get(a.ID, info, false, true, func() (searchRecord, error) { return one, nil })
	if err != nil || tiny.bytes != 0 || len(tiny.entries) != 0 {
		t.Fatal("oversize entry should bypass cache")
	}
	_, err = tiny.get(a.ID, info, false, false, func() (searchRecord, error) { return searchRecord{}, errors.New("unreadable") })
	if err == nil {
		t.Fatal("loader error swallowed")
	}
	cache.invalidate("missing")
	cache.invalidate(a.ID)
}

func TestWarmCacheCannotHideExternalCorruptionOrSymlinks(t *testing.T) {
	for _, kind := range []string{"same-size-restored-mtime", "replacement", "symlink", "directory", "oversized", "removed"} {
		t.Run(kind, func(t *testing.T) {
			s := testStore(t)
			d := mustCreate(t, s, input("original value"))
			if _, err := s.List(ListOptions{Status: "all", Query: "original"}); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(s.root, "documents", d.ID+".json")
			info, _ := os.Lstat(name)
			switch kind {
			case "same-size-restored-mtime":
				bytes, _ := os.ReadFile(name)
				bytes[0] = '!'
				time.Sleep(time.Millisecond)
				if err := os.WriteFile(name, bytes, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chtimes(name, info.ModTime(), info.ModTime()); err != nil {
					t.Fatal(err)
				}
			case "replacement":
				temp := filepath.Join(s.root, "replacement")
				os.WriteFile(temp, []byte("bad json"), 0600)
				os.Rename(temp, name)
			case "symlink":
				target := filepath.Join(s.root, "outside.json")
				os.WriteFile(target, []byte("bad json"), 0600)
				os.Remove(name)
				os.Symlink(target, name)
			case "directory":
				os.Remove(name)
				os.Mkdir(name, 0700)
			case "oversized":
				os.Truncate(name, maxRecordBytes+1)
			case "removed":
				os.Remove(name)
			}
			result, err := s.List(ListOptions{Status: "all", Query: "original"})
			if kind == "removed" {
				if err != nil || result.Total != 0 {
					t.Fatal("removed document retained")
				}
			} else if err == nil {
				t.Fatal("cache hid unsafe document")
			}
		})
	}
}

func TestSearchIndexReaderChecksIdentityAndRecordValidity(t *testing.T) {
	s := testStore(t)
	a := mustCreate(t, s, input("body"))
	b := mustCreate(t, s, input("other"))
	name := filepath.Join(s.root, "documents", a.ID+".json")
	other, _ := os.Lstat(filepath.Join(s.root, "documents", b.ID+".json"))
	if _, err := readSearchRecord(name, a.ID, other); err == nil {
		t.Fatal("changed identity accepted")
	}
	info, _ := os.Lstat(name)
	if _, err := readSearchRecord(name, b.ID, info); err == nil {
		t.Fatal("different document ID accepted")
	}
	if _, err := readSearchRecord(name+".missing", a.ID, info); err == nil {
		t.Fatal("missing document accepted")
	}
	link := filepath.Join(s.root, "link.json")
	os.Symlink(name, link)
	if _, err := readSearchRecord(link, a.ID, info); err == nil {
		t.Fatal("symlink race accepted")
	}
	if _, err := s.searchRecordLocked("missing", false, true); err == nil {
		t.Fatal("missing document accepted")
	}
}

func TestSearchCacheConcurrentReadersAndWriter(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("concurrent source"))
	d, _ = s.Action(d.ID, "publish", d.Version)
	var workers sync.WaitGroup
	for j := 0; j < 4; j++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := 0; i < 25; i++ {
				if _, err := s.List(ListOptions{Query: "concurrent"}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	for i := 0; i < 10; i++ {
		var err error
		d, err = s.Update(d.ID, input(fmt.Sprintf("concurrent %d", i)), d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	workers.Wait()
	reopened, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	r, err := reopened.List(ListOptions{Status: "all", Query: "concurrent 9"})
	if err != nil || r.Total != 1 {
		t.Fatal("restarted store did not rebuild index")
	}
}

func BenchmarkSearchList(b *testing.B) {
	s, err := NewStore(b.TempDir())
	if err != nil {
		b.Fatal(err)
	}
	for i := 0; i < 100; i++ {
		c := input(strings.Repeat("ordinary knowledge text ", 400) + "search-target")
		c.Title = fmt.Sprintf("Document %03d", i)
		d, err := s.Create(c, "", nil)
		if err != nil {
			b.Fatal(err)
		}
		if _, err = s.Action(d.ID, "publish", d.Version); err != nil {
			b.Fatal(err)
		}
	}
	options := ListOptions{Query: "search-target", Limit: 7}
	for _, cold := range []bool{true, false} {
		name := "warm"
		if cold {
			name = "cold"
		}
		b.Run(name, func(b *testing.B) {
			if _, err := s.List(options); err != nil {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if cold {
					s.search = newSearchCache(searchCacheBudget)
				}
				if _, err := s.List(options); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// The private encoder deliberately avoids HTML escaping, while JSON still
// escapes quotes and backslashes. Exercise both stored snapshots at the exact
// source limit so a derived-cache budget cannot reject a valid document.
func TestMaximumEscapedSourcesRemainSearchable(t *testing.T) {
	for _, character := range []string{"<", "&", "\\", "\""} {
		t.Run(fmt.Sprintf("byte-%02x", character[0]), func(t *testing.T) {
			s := testStore(t)
			prefix, suffix := "```text\nlimit-body-token\n", "\n```"
			source := prefix + strings.Repeat(character, int(MaxSourceBytes)-len(prefix)-len(suffix)) + suffix
			if int64(len(source)) != MaxSourceBytes {
				t.Fatal("fixture is not exactly the source limit")
			}
			d := mustCreate(t, s, input(source))
			name := filepath.Join(s.root, "documents", d.ID+".json")
			inspect := func(status string) {
				t.Helper()
				info, err := os.Stat(name)
				if err != nil {
					t.Fatal(err)
				}
				if info.Size() > maxRecordBytes {
					t.Fatalf("accepted document exceeds record bound: %d", info.Size())
				}
				t.Logf("%s: source=%d stored=%d bound=%d", status, len(source), info.Size(), maxRecordBytes)
				for _, query := range []string{"", "limit-body-token"} {
					result, err := s.List(ListOptions{Status: status, Query: query})
					if err != nil || result.Total != 1 {
						t.Fatalf("%s query=%q: count=%d err=%v", status, query, result.Total, err)
					}
				}
				stored, err := s.Get(d.ID, "")
				if err != nil || stored.Source != source {
					t.Fatal("working source no longer readable")
				}
			}
			inspect("draft")
			var err error
			d, err = s.Action(d.ID, "publish", d.Version)
			if err != nil {
				t.Fatal(err)
			}
			inspect("published")
			published, err := s.Get(d.ID, "published")
			if err != nil || published.Source != source {
				t.Fatal("published source no longer readable")
			}
		})
	}
}
