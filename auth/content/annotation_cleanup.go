package content

import "os"

// A permanently removed document cannot make its unreachable quotes exhaust
// the account budget. Drafts and trash still exist and retain their annotations.
// Reclamation and the new annotation commit in the same research-state write;
// unknown/unsafe paths fail closed instead of being treated as deletion.
func (s *Store) reclaimDeletedAnnotationsLocked(state *researchFile) error {
	root, err := s.openDocumentRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	deleted := map[string]bool{}
	for _, annotation := range state.Annotations {
		if _, checked := deleted[annotation.DocumentID]; checked {
			continue
		}
		info, err := root.Lstat(annotation.DocumentID + ".json")
		if os.IsNotExist(err) {
			deleted[annotation.DocumentID] = true
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			return bad(500, "批注关联文档暂时无法安全核对，请检查备份。")
		}
		deleted[annotation.DocumentID] = false
	}
	retained := make(map[string]Annotation, len(state.Annotations))
	for id, annotation := range state.Annotations {
		if !deleted[annotation.DocumentID] {
			retained[id] = annotation
		}
	}
	state.Annotations = retained
	return nil
}
