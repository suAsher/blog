package content

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

var documentID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var assetURL = regexp.MustCompile(`^/api/assets/[a-f0-9]{64}\.(png|jpe?g|gif|webp)$`)

type Store struct {
	root          string
	mu            sync.RWMutex
	capacityMu    sync.Mutex
	reservedBytes int64
	search        *searchCache
	freeBytes     func() (int64, error)
	location      *time.Location
	now           func() time.Time
}

func NewStore(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("content data directory is required")
	}
	location, err := contentLocation()
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	for _, dir := range []string{root, filepath.Join(root, "documents"), filepath.Join(root, "assets"), filepath.Join(root, "tmp")} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("unsafe content directory")
		}
	}
	// A killed process cannot run deferred import cleanup. Only our generated
	// temporary directories may be removed; committed documents/assets stay intact.
	select {
	case uploadSlot <- struct{}{}:
		entries, err := os.ReadDir(filepath.Join(root, "tmp"))
		if err != nil {
			<-uploadSlot
			return nil, err
		}
		ownedTemporary := regexp.MustCompile(`^import-[0-9]+$`)
		for _, entry := range entries {
			if entry.IsDir() && ownedTemporary.MatchString(entry.Name()) {
				if err := os.RemoveAll(filepath.Join(root, "tmp", entry.Name())); err != nil {
					<-uploadSlot
					return nil, errors.New("unable to clean interrupted import")
				}
			}
		}
		<-uploadSlot
	default:
		// A second Store in the same process must not erase a live import.
	}
	s := &Store{root: root, search: newSearchCache(searchCacheBudget), location: location, now: time.Now}
	s.freeBytes = func() (int64, error) {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(root, &stat); err != nil {
			return 0, err
		}
		return int64(stat.Bavail) * int64(stat.Bsize), nil
	}
	return s, nil
}

func normalizeContent(c Content) (Content, error) {
	c.Title = strings.TrimSpace(c.Title)
	c.Description = strings.TrimSpace(c.Description)
	c.Category = strings.TrimSpace(c.Category)
	c.Cover = strings.TrimSpace(c.Cover)
	if err := validateSource(c.Source); err != nil {
		return c, err
	}
	if c.Title == "" || strings.IndexFunc(c.Title, unicode.IsControl) >= 0 || utf8.RuneCountInString(c.Title) > 200 || utf8.RuneCountInString(c.Description) > 500 || utf8.RuneCountInString(c.Category) > 100 {
		return c, bad(400, "请填写有效标题、摘要与分类。")
	}
	if c.Date == "" {
		c.Date = time.Now().UTC().Format("2006-01-02")
	}
	if _, err := time.Parse("2006-01-02", c.Date); err != nil {
		return c, bad(400, "日期格式应为 YYYY-MM-DD。")
	}
	if c.Cover != "" && !assetURL.MatchString(c.Cover) && !(strings.HasPrefix(c.Cover, "/images/") && !strings.ContainsAny(c.Cover, "\\?#\r\n") && !strings.Contains(c.Cover, "..")) {
		return c, bad(400, "封面请使用已上传的图片。")
	}
	if len(c.Tags) > 20 {
		return c, bad(400, "最多添加 20 个标签。")
	}
	tags := []string{}
	seen := map[string]bool{}
	for _, tag := range c.Tags {
		tag = strings.TrimSpace(tag)
		if utf8.RuneCountInString(tag) > 64 || strings.IndexFunc(tag, unicode.IsControl) >= 0 {
			return c, bad(400, "标签长度不能超过 64 个字符。")
		}
		if tag != "" && !seen[tag] {
			tags = append(tags, tag)
			seen[tag] = true
		}
	}
	c.Tags = tags
	if c.Description == "" {
		text := []rune(strings.Join(strings.Fields(c.Source), " "))
		if len(text) > 140 {
			text = text[:140]
		}
		c.Description = string(text)
	}
	return normalizeMetadata(c)
}

func (s *Store) loadLocked(id string) (*record, error) {
	if !documentID.MatchString(id) {
		return nil, bad(404, "文档不存在。")
	}
	name := filepath.Join(s.root, "documents", id+".json")
	info, err := os.Lstat(name)
	if os.IsNotExist(err) {
		return nil, bad(404, "文档不存在。")
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
		return nil, bad(500, "文档暂时无法读取，请稍后重试。")
	}
	data, err := os.ReadFile(name)
	if err != nil {
		return nil, bad(500, "文档暂时无法读取，请稍后重试。")
	}
	var d record
	if json.Unmarshal(data, &d) != nil || d.ID != id || d.Version < 1 {
		return nil, bad(500, "文档记录异常，请从备份恢复。")
	}
	if err := validateStoredRecord(&d); err != nil {
		return nil, bad(500, "文档记录超出安全读取预算，请检查备份。")
	}
	return &d, nil
}

func (s *Store) ensureSpace(additional int64) error {
	s.capacityMu.Lock()
	defer s.capacityMu.Unlock()
	return s.ensureSpaceLocked(additional)
}

func (s *Store) ensureSpaceLocked(additional int64) error {
	free, err := s.freeBytes()
	if err != nil {
		return bad(503, "无法检查存储空间，请稍后重试。")
	}
	if additional < 0 || free < ReserveBytes+additional+s.reservedBytes {
		return bad(507, "服务器存储空间不足，请先扩容或清理已确认不需要的文件。")
	}
	return nil
}

// Reserve streamed bytes before they reach disk. Other writers see the full
// reservation until staging ends; this deliberately errs toward preserving space.
func (s *Store) reserveSpace(additional int64) (func(), error) {
	s.capacityMu.Lock()
	if err := s.ensureSpaceLocked(additional); err != nil {
		s.capacityMu.Unlock()
		return nil, err
	}
	s.reservedBytes += additional
	s.capacityMu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { s.capacityMu.Lock(); s.reservedBytes -= additional; s.capacityMu.Unlock() }) }, nil
}

func (s *Store) saveLocked(d *record) error {
	if err := validateStoredRecord(d); err != nil {
		return err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// This is a private data file, never an inline script. Avoid sixfold HTML
	// escaping so every accepted Markdown document remains readable at its limit.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(d); err != nil {
		return bad(500, "无法保存文档。")
	}
	data := buffer.Bytes()
	if int64(len(data)) > maxRecordBytes {
		return bad(413, "文档记录超出大小限制。")
	}
	releaseSpace, err := s.reserveSpace(int64(len(data)))
	if err != nil {
		return err
	}
	defer releaseSpace()
	directory := filepath.Join(s.root, "documents")
	file, err := os.CreateTemp(directory, ".write-")
	if err != nil {
		return bad(500, "无法创建保存文件，请检查存储权限。")
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return bad(500, "文档尚未保存，请保留当前编辑并重试。")
	}
	if err = os.Rename(name, filepath.Join(directory, d.ID+".json")); err != nil {
		return bad(500, "文档尚未保存，请重试。")
	}
	s.search.invalidate(d.ID)
	dir, err := os.Open(directory)
	if err != nil {
		return bad(500, "无法确认文档保存状态，请重新加载核对。")
	}
	defer dir.Close()
	if dir.Sync() != nil {
		return bad(500, "无法确认文档保存状态，请重新加载核对。")
	}
	return nil
}

func (s *Store) Create(c Content, sourcePath string, aliases map[string]string) (Detail, error) {
	c, err := normalizeContent(c)
	if err != nil {
		return Detail{}, err
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return Detail{}, bad(503, "暂时无法创建文档。")
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	d := &record{
		ID: hex.EncodeToString(random), Version: 1, Status: "draft", Working: c,
		CreatedAt: now, UpdatedAt: now, SourcePath: sourcePath, Aliases: aliases,
	}
	if strings.TrimSpace(c.Source) != "" {
		d.Activity = addActivity(nil, s.now())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.saveLocked(d); err != nil {
		return Detail{}, err
	}
	return s.detail(d, "")
}

func (s *Store) Get(id, view string) (Detail, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return Detail{}, err
	}
	return s.detail(d, view)
}

func summary(d *record, c Content) Summary {
	kind := c.Kind
	if kind == "" {
		kind = "article"
	}
	return Summary{
		ID: d.ID, Title: c.Title, Description: c.Description, Date: c.Date,
		Tags: append([]string{}, c.Tags...), Category: c.Category, Cover: c.Cover,
		ReadingMinutes: readingMinutes(c.Source), Status: d.Status, Version: d.Version,
		CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt, PublishedAt: d.PublishedAt,
		HasUnpublishedChanges: d.Published != nil && !sameContent(d.Working, *d.Published),
		Kind:                  kind, Maturity: c.Maturity, Series: c.Series,
		Related: append([]string{}, c.Related...),
	}
}

func (s *Store) detail(d *record, view string) (Detail, error) {
	c := d.Working
	if view == "published" {
		if d.Status != "published" || d.Published == nil {
			return Detail{}, bad(404, "这篇文档尚未发布。")
		}
		c = *d.Published
	}
	rendered, err := renderMarkdown(c.Source, d.Aliases)
	if err != nil {
		return Detail{}, err
	}
	return Detail{Summary: summary(d, c), Source: c.Source, HTML: rendered.HTML, Headings: rendered.Headings, SourcePath: d.SourcePath}, nil
}

func (s *Store) Update(id string, c Content, version int) (Detail, error) {
	return s.update(id, c, version, metadataPresence{true, true, true, true})
}

func (s *Store) update(id string, c Content, version int, present metadataPresence) (Detail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return Detail{}, err
	}
	if d.Version != version {
		return Detail{}, bad(409, "文档已在其他窗口更新，请先重新加载。")
	}
	if d.Status == "trash" {
		return Detail{}, bad(409, "请先从垃圾箱恢复文档。")
	}
	c, err = normalizeContent(preserveMetadata(c, d.Working, present))
	if err != nil {
		return Detail{}, err
	}
	for _, target := range c.Related {
		if target == id {
			return Detail{}, bad(400, "文档不能关联自身。")
		}
	}
	if d.Working.Source != c.Source && strings.TrimSpace(c.Source) != "" {
		d.Activity = addActivity(d.Activity, s.now())
	}
	d.Working = c
	d.Version++
	d.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if err := s.saveLocked(d); err != nil {
		return Detail{}, err
	}
	return s.detail(d, "")
}

func (s *Store) Action(id, action string, version int) (Detail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return Detail{}, err
	}
	if d.Version != version {
		return Detail{}, bad(409, "文档已更新，请重新加载后操作。")
	}
	switch action {
	case "publish":
		if d.Status == "trash" || strings.TrimSpace(d.Working.Source) == "" {
			return Detail{}, bad(400, "请恢复文档并填写正文后再发布。")
		}
		snapshot := copyContent(d.Working)
		d.Published = &snapshot
		d.Status = "published"
		d.PublishedAt = s.now().UTC().Format(time.RFC3339Nano)
	case "unpublish":
		if d.Status != "published" {
			return Detail{}, bad(409, "文档当前未发布。")
		}
		d.Status = "draft"
		d.Published = nil
		d.PublishedAt = ""
	case "trash":
		if d.Status == "trash" {
			return Detail{}, bad(409, "文档已在垃圾箱。")
		}
		d.Status = "trash"
	case "restore":
		if d.Status != "trash" {
			return Detail{}, bad(409, "文档不在垃圾箱。")
		}
		d.Status = "draft"
		d.Published = nil
		d.PublishedAt = ""
	default:
		return Detail{}, bad(404, "操作不存在。")
	}
	d.Version++
	d.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	if err := s.saveLocked(d); err != nil {
		return Detail{}, err
	}
	return s.detail(d, "")
}

func (s *Store) Delete(id string, version int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return err
	}
	if d.Version != version {
		return bad(409, "文档已更新，请重新加载后操作。")
	}
	if d.Status != "trash" {
		return bad(409, "请先移至垃圾箱，再永久删除。")
	}
	if os.Remove(filepath.Join(s.root, "documents", id+".json")) != nil {
		return bad(500, "删除失败，请重试。")
	}
	s.search.invalidate(id)
	dir, err := os.Open(filepath.Join(s.root, "documents"))
	if err != nil {
		return bad(500, "无法确认删除状态。")
	}
	defer dir.Close()
	return dir.Sync()
}

func (s *Store) quota() Quota {
	free, _ := s.freeBytes()
	var used int64
	_ = filepath.WalkDir(s.root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				used += info.Size()
			}
		}
		return nil
	})
	return Quota{UsedBytes: used, FreeBytes: free, ReserveBytes: ReserveBytes, MaxUploadBytes: MaxUploadBytes, MaxImageBytes: MaxImageBytes, MaxSourceBytes: MaxSourceBytes}
}
