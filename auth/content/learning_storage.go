package content

import (
	"encoding/json"
	"os"
)

func (s *Store) loadLearningLocked() (*learningFile, error) {
	directory, err := s.openReadingRoot()
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	data, err := readResearchFile(directory, "learning.json", maxLearningBytes, true)
	if os.IsNotExist(err) {
		return newLearningFile(), nil
	}
	if err != nil {
		return nil, err
	}
	state := &learningFile{}
	if strictResearchJSON(data, state) != nil || validateLearningFile(state) != nil {
		return nil, bad(500, "路线状态格式异常，请检查备份。")
	}
	return state, nil
}
func (s *Store) saveLearningLocked(state *learningFile) error {
	if err := validateLearningFile(state); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > maxLearningBytes {
		return bad(413, "路线状态超出 8 MiB 预算，请整理路线与章节。")
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
	info, err := directory.Lstat("learning.json")
	if err != nil && !os.IsNotExist(err) {
		return bad(500, "路线状态保存目标无法检查。")
	}
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return bad(500, "路线状态保存目标不安全。")
	}
	id, err := researchID()
	if err != nil {
		return err
	}
	name := ".learning-" + id
	file, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return bad(500, "无法创建路线状态保存文件。")
	}
	defer directory.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return bad(500, "路线状态尚未保存，请重试。")
	}
	if directory.Rename(name, "learning.json") != nil {
		return bad(500, "路线状态尚未保存，请重试。")
	}
	handle, err := directory.Open(".")
	if err != nil {
		return bad(500, "无法确认路线状态保存。")
	}
	defer handle.Close()
	if handle.Sync() != nil {
		return bad(500, "无法确认路线状态保存。")
	}
	return nil
}
