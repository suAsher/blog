package content

import (
	"container/list"
	"sync"
)

const passageCacheBudget int64 = 8 << 20

type passageCacheEntry struct {
	key   string
	value passageIndex
	size  int64
}

// Content-addressed indexes never contain document identity or working state.
// Every query first revalidates the current published record in searchCache;
// old indexes can remain bounded in LRU without exposing withdrawn snapshots.
// Store.mu precedes this mutex. Returned indexes are immutable.
type passageCache struct {
	mu           sync.Mutex
	entries      map[string]*list.Element
	order        *list.List
	bytes, limit int64
}

func newPassageCache(limit int64) *passageCache {
	return &passageCache{entries: map[string]*list.Element{}, order: list.New(), limit: limit}
}

func passageIndexBytes(index passageIndex) int64 {
	size := int64(512 + len(index.revision))
	for _, block := range index.blocks {
		size += int64(192 + len(block.anchor) + len(block.kind) + len(block.text) + len(block.indexed))
		for _, heading := range block.headings {
			size += int64(64 + len(heading.Slug) + len(heading.Text))
		}
	}
	return size
}

func (cache *passageCache) get(source string) passageIndex {
	key := passageRevision(source)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if element := cache.entries[key]; element != nil {
		cache.order.MoveToFront(element)
		return element.Value.(passageCacheEntry).value
	}
	value := buildPassageIndex(source)
	size := passageIndexBytes(value)
	if size > cache.limit {
		return value
	}
	for cache.bytes+size > cache.limit && cache.order.Len() > 0 {
		last := cache.order.Back()
		entry := last.Value.(passageCacheEntry)
		delete(cache.entries, entry.key)
		cache.bytes -= entry.size
		cache.order.Remove(last)
	}
	element := cache.order.PushFront(passageCacheEntry{key, value, size})
	cache.entries[key] = element
	cache.bytes += size
	return value
}
