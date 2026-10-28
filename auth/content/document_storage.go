package content

import (
	"os"
)

// Keep history and working/published state under the same anchored directory.
// Refuse replaced/symlinked directories before any read, rename or delete.
func (s *Store) openDocumentRoot() (*os.Root, error) {
	base, err := os.OpenRoot(s.root)
	if err != nil {
		return nil, bad(500, "文档目录暂时无法读取。")
	}
	defer base.Close()
	info, err := base.Lstat("documents")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, bad(500, "文档目录不安全，请检查存储配置。")
	}
	root, err := base.OpenRoot("documents")
	if err != nil {
		return nil, bad(500, "文档目录暂时无法打开。")
	}
	check, err := root.Stat(".")
	if err != nil || !os.SameFile(info, check) {
		root.Close()
		return nil, bad(500, "文档目录发生变化，请重试。")
	}
	return root, nil
}
