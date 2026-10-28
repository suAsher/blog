package content

import (
	"archive/zip"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"unicode"

	"go.yaml.in/yaml/v3"
)

func markdownExport(content Content) ([]byte, error) {
	metadata, err := yaml.Marshal(content)
	if err != nil {
		return nil, bad(500, "暂时无法生成 Markdown。")
	}
	return []byte("---\n" + string(metadata) + "---\n\n" + content.Source), nil
}

func exportName(title string) string {
	value := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\:"*?<>|`, r) {
			return '_'
		}
		return r
	}, title)
	value = strings.TrimSpace(value)
	if value == "" {
		value = "document"
	}
	return value
}

type exportAsset struct{ member, id string }

func (s *Store) exportHTTP(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.RLock()
	document, err := s.loadLocked(id)
	s.mu.RUnlock()
	if err != nil {
		respondError(w, err)
		return
	}
	content := document.Working
	aliases := document.Aliases
	if r.URL.Query().Get("view") == "published" {
		if document.Status != "published" || document.Published == nil {
			respondError(w, bad(404, "这篇文档尚未发布。"))
			return
		}
		content = *document.Published
		aliases = publishedAliases(document)
	}
	format := r.URL.Query().Get("format")
	if format != "" && format != "md" && format != "zip" {
		respondError(w, bad(400, "导出格式应为 Markdown 或 ZIP。"))
		return
	}
	if format != "zip" {
		data, err := markdownExport(content)
		if err != nil {
			respondError(w, err)
			return
		}
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": exportName(content.Title) + ".md"}))
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		_, _ = w.Write(data)
		return
	}
	if err := validateSource(content.Source); err != nil {
		respondError(w, err)
		return
	}
	member := document.SourcePath
	if member == "" {
		member = exportName(content.Title) + ".md"
	} else {
		member = strings.TrimSuffix(member, path.Ext(member)) + ".md"
	}
	if _, err := safeUploadPath(member); err != nil {
		respondError(w, bad(500, "原始文档路径异常，无法打包。"))
		return
	}
	entries := []exportAsset{}
	seen := map[string]string{member: "document"}
	addAsset := func(destination, location string) error {
		assetID := strings.TrimPrefix(location, "/api/assets/")
		if !assetName.MatchString(assetID) {
			return bad(500, "配图引用异常，无法打包。")
		}
		assetMember := ""
		if !strings.HasPrefix(destination, "/api/assets/") {
			if resolved, ok := imageRelativePath(member, destination); ok {
				assetMember = resolved
			}
		}
		if assetMember == "" {
			assetMember = path.Join(path.Dir(member), "assets", assetID)
			relative := "assets/" + assetID
			content.Source = strings.ReplaceAll(content.Source, destination, relative)
			if content.Cover == destination || content.Cover == location {
				content.Cover = relative
			}
		}
		if _, err := safeUploadPath(assetMember); err != nil {
			return bad(500, "配图归档路径异常。")
		}
		if previous, found := seen[assetMember]; found {
			if previous != assetID {
				return bad(409, "配图路径冲突，无法安全打包。")
			}
			return nil
		}
		file, err := openAsset(s.root, assetID)
		if err != nil {
			return bad(409, "部分配图已不存在，请修复后导出。")
		}
		file.Close()
		seen[assetMember] = assetID
		entries = append(entries, exportAsset{assetMember, assetID})
		return nil
	}
	for destination, location := range aliases {
		if err := addAsset(destination, location); err != nil {
			respondError(w, err)
			return
		}
	}
	destinations := markdownImages(content.Source)
	if content.Cover != "" {
		destinations = append(destinations, content.Cover)
	}
	for _, destination := range destinations {
		if assetURL.MatchString(destination) {
			if err := addAsset(destination, destination); err != nil {
				respondError(w, err)
				return
			}
		}
	}
	data, err := markdownExport(content)
	if err != nil {
		respondError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": exportName(content.Title) + ".zip"}))
	archive := zip.NewWriter(w)
	entry, err := archive.Create(member)
	if err != nil {
		panic(http.ErrAbortHandler)
	}
	if _, err = entry.Write(data); err != nil {
		panic(http.ErrAbortHandler)
	}
	for _, asset := range entries {
		entry, err := archive.Create(asset.member)
		if err != nil {
			panic(http.ErrAbortHandler)
		}
		file, err := openAsset(s.root, asset.id)
		if err != nil {
			panic(http.ErrAbortHandler)
		}
		_, err = io.Copy(entry, file)
		_ = file.Close()
		if err != nil {
			panic(http.ErrAbortHandler)
		}
	}
	if archive.Close() != nil {
		panic(http.ErrAbortHandler)
	}
}
