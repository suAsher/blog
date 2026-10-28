package content

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"syscall"
)

func newResearchFile() *researchFile {
	return &researchFile{SchemaVersion: 1, Annotations: map[string]Annotation{}, Workspaces: map[string]Workspace{}}
}
func researchID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", bad(503, "暂时无法生成研究记录标识。")
	}
	return hex.EncodeToString(b), nil
}

// Existing installs acquire empty research state lazily. All paths are confined
// to a checked private directory and all reads reject symlinks and file changes.
func (s *Store) loadResearchLocked() (*researchFile, error) {
	directory, err := s.openReadingRoot()
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	data, err := readResearchFile(directory, "research.json", maxResearchBytes, true)
	if os.IsNotExist(err) {
		return newResearchFile(), nil
	}
	if err != nil {
		return nil, err
	}
	state := &researchFile{}
	if strictResearchJSON(data, state) != nil || validateResearchFile(state) != nil {
		return nil, bad(500, "研究状态格式异常，请检查备份。")
	}
	return state, nil
}
func readResearchFile(directory *os.Root, name string, limit int64, private bool) ([]byte, error) {
	info, err := directory.Lstat(name)
	if os.IsNotExist(err) {
		return nil, err
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit || (private && info.Mode().Perm()&0077 != 0) {
		return nil, bad(500, "研究数据文件不安全或超出预算。")
	}
	file, err := directory.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, bad(500, "研究数据暂时无法读取。")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !sameSearchFile(info, before) {
		return nil, bad(500, "研究数据读取期间发生变化。")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, bad(500, "研究数据超出读取预算。")
	}
	after, err := file.Stat()
	if err != nil || !sameSearchFile(before, after) {
		return nil, bad(500, "研究数据读取期间发生变化。")
	}
	return data, nil
}
func (s *Store) saveResearchLocked(state *researchFile) error {
	if err := validateResearchFile(state); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > maxResearchBytes {
		return bad(413, "研究状态超出 16 MiB 预算，请整理批注或专题。")
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
	// Refuse unsafe destinations even if they appeared after the initial load.
	info, err := directory.Lstat("research.json")
	if err != nil && !os.IsNotExist(err) {
		return bad(500, "研究状态保存目标无法检查。")
	}
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return bad(500, "研究状态保存目标不安全。")
	}
	id, err := researchID()
	if err != nil {
		return err
	}
	name := ".research-" + id
	file, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return bad(500, "无法创建研究状态保存文件。")
	}
	defer directory.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return bad(500, "研究状态尚未保存，请重试。")
	}
	if directory.Rename(name, "research.json") != nil {
		return bad(500, "研究状态尚未保存，请重试。")
	}
	handle, err := directory.Open(".")
	if err != nil {
		return bad(500, "无法确认研究状态保存。")
	}
	defer handle.Close()
	if handle.Sync() != nil {
		return bad(500, "无法确认研究状态保存。")
	}
	return nil
}

func (s *Store) researchDocumentLocked(id string, published bool) error {
	if !documentID.MatchString(id) {
		return bad(404, "研究文档不存在或暂不可用。")
	}
	base, err := os.OpenRoot(s.root)
	if err != nil {
		return bad(500, "研究文档暂时无法读取。")
	}
	defer base.Close()
	info, err := base.Lstat("documents")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return bad(500, "研究文档目录不安全。")
	}
	directory, err := base.OpenRoot("documents")
	if err != nil {
		return bad(500, "研究文档暂时无法读取。")
	}
	defer directory.Close()
	actual, err := directory.Stat(".")
	if err != nil || !os.SameFile(info, actual) {
		return bad(500, "研究文档目录发生变化。")
	}
	data, err := readResearchFile(directory, id+".json", maxRecordBytes, false)
	if os.IsNotExist(err) {
		return bad(404, "研究文档不存在或暂不可用。")
	}
	if err != nil {
		return err
	}
	var doc record
	if json.Unmarshal(data, &doc) != nil || doc.ID != id || validateStoredRecord(&doc) != nil {
		return bad(500, "研究文档记录异常。")
	}
	if doc.Status == "trash" || (published && (doc.Status != "published" || doc.Published == nil)) {
		return bad(404, "研究文档不存在或暂不可用。")
	}
	return nil
}
