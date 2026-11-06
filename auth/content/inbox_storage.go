package content

import (
	"encoding/json"
	"os"
)

func (s *Store) loadInboxLocked() (*inboxFile, error) {
	directory, err := s.openReadingRoot()
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	data, err := readResearchFile(directory, "inbox.json", maxInboxBytes, true)
	if os.IsNotExist(err) {
		return newInboxFile(), nil
	}
	if err != nil {
		return nil, err
	}
	state := &inboxFile{}
	if strictResearchJSON(data, state) != nil || validateInboxFile(state) != nil {
		return nil, bad(500, "收件箱状态格式异常，请检查备份。")
	}
	return state, nil
}

func (s *Store) saveInboxLocked(state *inboxFile) error {
	if err := validateInboxFile(state); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > maxInboxBytes {
		return bad(413, "收件箱状态超出 2 MiB 预算。")
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
	info, err := directory.Lstat("inbox.json")
	if err != nil && !os.IsNotExist(err) {
		return bad(500, "无法检查收件箱保存位置。")
	}
	if err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return bad(500, "收件箱保存位置不安全。")
	}
	id, err := researchID()
	if err != nil {
		return err
	}
	name := ".inbox-" + id
	file, err := directory.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return bad(500, "无法创建收件箱保存文件。")
	}
	defer directory.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return bad(500, "收件箱尚未保存，请重试。")
	}
	if directory.Rename(name, "inbox.json") != nil {
		return bad(500, "收件箱尚未保存，请重试。")
	}
	handle, err := directory.Open(".")
	if err != nil {
		return bad(500, "无法确认收件箱保存。")
	}
	defer handle.Close()
	if handle.Sync() != nil {
		return bad(500, "无法确认收件箱保存。")
	}
	return nil
}
