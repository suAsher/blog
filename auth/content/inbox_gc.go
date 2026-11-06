package content

import "os"

// Retain recoverable trash and release only entries whose document was
// permanently removed. This runs after the caller's CAS check. The returned copy
// is persisted together with the requested stage change, never as a separate
// cleanup write, so a failed mutation cannot advance or partially change state.
func (s *Store) retainedInboxEntriesLocked(previous map[string]inboxEntry) (map[string]inboxEntry, error) {
	directory, err := s.openDocumentRoot()
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	entries := make(map[string]inboxEntry, len(previous))
	for id, entry := range previous {
		info, err := directory.Lstat(id + ".json")
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
			return nil, bad(500, "收件箱关联文档不安全或无法检查，请检查存储后重试。")
		}
		// Existence is enough: cleanup does not decode or modify document data.
		// Invalid JSON is retained and remains an explicit error on document reads.
		entries[id] = entry
	}
	return entries, nil
}
