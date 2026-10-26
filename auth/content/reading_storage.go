package content

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"syscall"
)

func emptyReadingFile() *readingFile {
	return &readingFile{SchemaVersion: 1, Entries: map[string]ReadingEntry{}, Receipts: []readingReceipt{}}
}

// Anchor all operations to directory handles. Root prevents escaping the content
// directory even if a local rename occurs between path checks and opening files.
func (s *Store) openReadingRoot() (*os.Root, error) {
	base, err := os.OpenRoot(s.root)
	if err != nil {
		return nil, bad(500, "阅读状态目录暂时无法读取。")
	}
	defer base.Close()
	info, err := base.Lstat("state")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return nil, bad(500, "阅读状态目录不安全，请检查存储配置。")
	}
	directory, err := base.OpenRoot("state")
	if err != nil {
		return nil, bad(500, "阅读状态目录暂时无法打开。")
	}
	check, err := directory.Stat(".")
	if err != nil || !os.SameFile(info, check) {
		directory.Close()
		return nil, bad(500, "阅读状态目录发生变化，请重试。")
	}
	return directory, nil
}

func (s *Store) loadReadingLocked() (*readingFile, error) {
	directory, err := s.openReadingRoot()
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	info, err := directory.Lstat("reading.json")
	if os.IsNotExist(err) {
		return emptyReadingFile(), nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxReadingBytes || info.Mode().Perm()&0077 != 0 {
		return nil, bad(500, "阅读状态文件不安全或超出预算，请检查备份。")
	}
	file, err := directory.OpenFile("reading.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, bad(500, "阅读状态暂时无法读取。")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !sameSearchFile(info, before) {
		return nil, bad(500, "阅读状态读取期间发生变化，请重试。")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxReadingBytes+1))
	if err != nil || len(data) > maxReadingBytes {
		return nil, bad(500, "阅读状态超出安全读取预算。")
	}
	after, err := file.Stat()
	if err != nil || !sameSearchFile(before, after) {
		return nil, bad(500, "阅读状态读取期间发生变化，请重试。")
	}
	state := &readingFile{}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(state) != nil || decoder.Decode(new(any)) != io.EOF {
		return nil, bad(500, "阅读状态格式异常，请从备份恢复。")
	}
	if err := validateReadingShape(data); err != nil {
		return nil, err
	}
	if err := validateReadingFile(state); err != nil {
		return nil, err
	}
	return state, nil
}

func validateReadingShape(data []byte) error {
	var header map[string]json.RawMessage
	if json.Unmarshal(data, &header) != nil {
		return bad(500, "阅读状态格式异常，请检查备份。")
	}
	for _, field := range []string{"schemaVersion", "revision", "entries", "receipts"} {
		value := bytes.TrimSpace(header[field])
		if len(value) == 0 || bytes.Equal(value, []byte("null")) {
			return bad(500, "阅读状态头字段缺失，请检查备份。")
		}
	}
	var raw struct {
		Entries map[string]map[string]json.RawMessage `json:"entries"`
	}
	if json.Unmarshal(data, &raw) != nil || raw.Entries == nil {
		return bad(500, "阅读状态内容异常，请检查备份。")
	}
	for _, entry := range raw.Entries {
		for _, field := range []string{"bookmarked", "read", "progress", "updatedAt", "fieldRevisions"} {
			value := bytes.TrimSpace(entry[field])
			if len(value) == 0 || bytes.Equal(value, []byte("null")) {
				return bad(500, "阅读状态字段缺失，请检查备份。")
			}
		}
		var revisions map[string]json.RawMessage
		if json.Unmarshal(entry["fieldRevisions"], &revisions) != nil || revisions == nil {
			return bad(500, "阅读状态字段版本无效。")
		}
		for _, field := range []string{"bookmarked", "read", "progress", "review"} {
			value := bytes.TrimSpace(revisions[field])
			if len(value) == 0 || bytes.Equal(value, []byte("null")) {
				return bad(500, "阅读状态字段版本缺失。")
			}
		}
	}
	return nil
}

func (s *Store) saveReadingLocked(state *readingFile) error {
	if err := validateReadingFile(state); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > maxReadingBytes {
		return bad(413, "阅读状态超出 4 MiB 预算，请先导出并整理阅读记录。")
	}
	release, err := s.reserveSpace(int64(len(data)))
	if err != nil {
		return err
	}
	defer release()
	directory, err := s.openReadingRoot()
	if err != nil {
		return err
	}
	defer directory.Close()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return bad(503, "暂时无法保存阅读状态。")
	}
	name := ".reading-" + hex.EncodeToString(random)
	file, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return bad(500, "无法创建阅读状态保存文件。")
	}
	defer directory.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return bad(500, "阅读状态尚未保存，请保留本机待同步记录并重试。")
	}
	if err := directory.Rename(name, "reading.json"); err != nil {
		return bad(500, "阅读状态尚未保存，请重试。")
	}
	handle, err := directory.Open(".")
	if err != nil {
		return bad(500, "无法确认阅读状态保存，请重新加载核对。")
	}
	defer handle.Close()
	if handle.Sync() != nil {
		return bad(500, "无法确认阅读状态保存，请重新加载核对。")
	}
	return nil
}
