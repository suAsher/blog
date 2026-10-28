package content

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"go.yaml.in/yaml/v3"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
)

const maxImportReferences = 1000
const maxImportReferenceBytes = 2048

type importDecision struct {
	Path       string `json:"path"`
	Action     string `json:"action"`
	ExistingID string `json:"existingId,omitempty"`
	Version    int    `json:"version,omitempty"`
}
type importDecisions struct {
	RequestID string           `json:"requestId,omitempty"`
	Paths     []importDecision `json:"paths"`
}
type importCandidate struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	Status     string `json:"status"`
	ExistingID string `json:"existingId,omitempty"`
	Version    int    `json:"version,omitempty"`
	Message    string `json:"message,omitempty"`
}
type importOutcome struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	ID      string `json:"id,omitempty"`
	Version int    `json:"version,omitempty"`
	Message string `json:"message,omitempty"`
}
type importPreview struct {
	Candidates []importCandidate `json:"candidates"`
	Skipped    []importSkip      `json:"skipped"`
	Unresolved []unresolvedImage `json:"unresolvedImages"`
	Warnings   []string          `json:"warnings"`
	Quota      Quota             `json:"quota"`
}
type preparedImport struct {
	preview       importPreview
	documents     map[string]Content
	aliases       map[string]map[string]string
	assets        map[string]stagedFile
	implicitDates map[string]bool
}

func validateImportDecisions(options *importDecisions) error {
	if options.RequestID != "" && !documentID.MatchString(options.RequestID) {
		return bad(400, "导入请求标识必须为 32 位十六进制字符。")
	}
	if len(options.Paths) > 500 {
		return bad(400, "导入决策超出文件数量限制。")
	}
	seen := map[string]bool{}
	for _, decision := range options.Paths {
		if _, err := safeUploadPath(decision.Path); err != nil {
			return err
		}
		if seen[decision.Path] {
			return bad(400, "导入路径决策重复。")
		}
		seen[decision.Path] = true
		if decision.Action != "skip" && decision.Action != "create" && decision.Action != "update" {
			return bad(400, "请选择跳过、新建或更新。")
		}
		if decision.Action == "update" {
			if !documentID.MatchString(decision.ExistingID) || decision.Version < 1 || int64(decision.Version) > maxSafeRevision {
				return bad(400, "更新导入必须提供文档标识和当前版本。")
			}
		} else if decision.ExistingID != "" || decision.Version != 0 {
			return bad(400, "仅更新决策可包含已有文档版本。")
		}
	}
	return nil
}
func stagedAssetURL(file stagedFile) (string, error) {
	ext, err := inspectImage(file.Temp)
	if err != nil {
		return "", err
	}
	opened, err := os.Open(file.Temp)
	if err != nil {
		return "", bad(500, "无法读取配图。")
	}
	defer opened.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, opened); err != nil {
		return "", bad(500, "无法校验配图。")
	}
	return "/api/assets/" + hex.EncodeToString(hash.Sum(nil)) + "." + ext, nil
}
func (s *Store) prepareImport(files []stagedFile) (preparedImport, error) {
	result := preparedImport{preview: importPreview{Candidates: []importCandidate{}, Skipped: []importSkip{}, Unresolved: []unresolvedImage{}, Warnings: []string{}}, documents: map[string]Content{}, aliases: map[string]map[string]string{}, assets: map[string]stagedFile{}, implicitDates: map[string]bool{}}
	if len(files) == 0 {
		return result, bad(400, "请选择要导入的文档。")
	}
	projected := map[string]int64{}
	assets := map[string]string{}
	basenames := map[string][]string{}
	flat := true
	hasDocument, hasImage := false, false
	for _, file := range files {
		if strings.Contains(file.Path, "/") {
			flat = false
		}
		if hiddenPath(file.Path) {
			continue
		}
		ext := strings.ToLower(path.Ext(file.Path))
		hasDocument = hasDocument || ext == ".md" || ext == ".markdown" || ext == ".txt"
		hasImage = hasImage || imageExtension(file.Path)
	}
	if !hasDocument && hasImage {
		return result, bad(400, "请同时选择 Markdown 或 TXT 文档；单独上传图片请使用编辑器的插图功能。")
	}
	for _, file := range files {
		if hiddenPath(file.Path) {
			result.preview.Skipped = append(result.preview.Skipped, importSkip{file.Path, "隐藏目录或密钥类文件不导入。"})
			continue
		}
		if imageExtension(file.Path) {
			url, err := stagedAssetURL(file)
			if err != nil {
				result.preview.Skipped = append(result.preview.Skipped, importSkip{file.Path, err.Error()})
				continue
			}
			assets[file.Path] = url
			basenames[path.Base(file.Path)] = append(basenames[path.Base(file.Path)], url)
			result.assets[url] = file
		} else if ext := strings.ToLower(path.Ext(file.Path)); ext != ".md" && ext != ".markdown" && ext != ".txt" {
			result.preview.Skipped = append(result.preview.Skipped, importSkip{file.Path, "仅导入 Markdown、TXT 和 PNG/JPEG/GIF/WebP 配图；SVG 不接受。"})
		}
	}
	referenceCount := 0
	for _, file := range files {
		ext := strings.ToLower(path.Ext(file.Path))
		if hiddenPath(file.Path) || (ext != ".md" && ext != ".markdown" && ext != ".txt") {
			continue
		}
		candidate := importCandidate{Path: file.Path, Status: "new"}
		data, err := os.ReadFile(file.Temp)
		if err != nil {
			err = bad(500, "文档读取失败，请重试。")
		}
		var content Content
		if err == nil {
			content, err = parseImported(file.Path, data)
		}
		if err != nil {
			candidate.Status = "invalid"
			candidate.Message = err.Error()
			result.preview.Candidates = append(result.preview.Candidates, candidate)
			continue
		}
		aliases := map[string]string{}
		destinations := markdownImages(content.Source)
		if content.Cover != "" {
			destinations = append(destinations, content.Cover)
		}
		referenceCount += len(destinations)
		if referenceCount > maxImportReferences {
			return result, bad(413, "一批最多检查 1000 个配图引用，请拆分导入。")
		}
		for _, destination := range destinations {
			if len(destination) > maxImportReferenceBytes {
				return result, bad(413, "配图路径不能超过 2048 字节。")
			}
		}
		for _, destination := range destinations {
			if assetURL.MatchString(destination) {
				if asset, err := openAsset(s.root, strings.TrimPrefix(destination, "/api/assets/")); err == nil {
					asset.Close()
					aliases[destination] = destination
					continue
				}
			}
			resolved, valid := imageRelativePath(file.Path, destination)
			if valid {
				if url, found := assets[resolved]; found {
					aliases[destination] = url
					continue
				}
				if found := basenames[path.Base(resolved)]; flat && len(found) == 1 {
					aliases[destination] = found[0]
					result.preview.Warnings = appendImportWarning(result.preview.Warnings, file.Path+" 的配图按唯一文件名关联；建议使用文件夹上传保留路径。")
					continue
				}
			}
			result.preview.Unresolved = append(result.preview.Unresolved, unresolvedImage{file.Path, destination})
		}
		if content.Cover != "" {
			if value, found := aliases[content.Cover]; found {
				content.Cover = value
			} else {
				content.Cover = ""
				result.preview.Warnings = append(result.preview.Warnings, file.Path+" 的封面未找到，已留空。")
			}
		}
		content, err = normalizeContent(content)
		if err != nil {
			candidate.Status = "invalid"
			candidate.Message = err.Error()
			result.preview.Candidates = append(result.preview.Candidates, candidate)
			continue
		}
		result.implicitDates[file.Path] = !importExplicitDate(file.Path, data)
		candidate.Title = content.Title
		encoded, _ := json.Marshal(content)
		projected[file.Path] = int64(len(encoded)) + 1024
		result.documents[file.Path] = content
		result.aliases[file.Path] = aliases
		result.preview.Candidates = append(result.preview.Candidates, candidate)
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	err := s.visitImportRecordsLocked(func(d *record) {
		if d.Status == "trash" {
			return
		}
		for i, candidate := range result.preview.Candidates {
			if candidate.Status == "invalid" || candidate.Status == "duplicate" {
				continue
			}
			content := result.documents[candidate.Path]
			equal := sameImportedContent(content, d.Working, result.implicitDates[candidate.Path]) && sameAliases(result.aliases[candidate.Path], d.Aliases)
			if equal || d.SourcePath == candidate.Path {
				if candidate.ExistingID == "" || equal {
					candidate.ExistingID = d.ID
					candidate.Version = d.Version
					candidate.Status = "changed"
					if equal {
						candidate.Status = "duplicate"
					}
					if !equal {
						working, _ := json.Marshal(d.Working)
						published, _ := json.Marshal(d.Published)
						projected[candidate.Path] += int64(historySize(d.History) + 2*len(working) + len(published))
					}
					result.preview.Candidates[i] = candidate
				}
			}
		}
	})
	if err != nil {
		return result, err
	}

	var estimated int64
	for _, size := range projected {
		estimated += size
	}
	for _, file := range result.assets {
		estimated += file.Size
	}
	if err := s.ensureSpace(estimated); err != nil {
		return result, err
	}
	result.preview.Quota = s.quota()
	return result, nil
}
func importExplicitDate(name string, data []byte) bool {
	source := strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n")
	if strings.EqualFold(path.Ext(name), ".txt") || !strings.HasPrefix(source, "---\n") {
		return false
	}
	end := strings.Index(source[4:], "\n---")
	if end < 0 {
		return false
	}
	var front struct {
		Date yaml.Node `yaml:"date"`
	}
	if yaml.Unmarshal([]byte(source[4:4+end]), &front) != nil {
		return false
	}
	return front.Date.Kind != 0 && strings.TrimSpace(front.Date.Value) != ""
}
func sameImportedContent(a, b Content, implicitDate bool) bool {
	if implicitDate {
		a.Date = b.Date
	}
	return sameContent(a, b)
}
func (s *Store) visitImportRecordsLocked(visit func(*record)) error {
	entries, err := os.ReadDir(path.Join(s.root, "documents"))
	if err != nil {
		return bad(500, "无法检查已有文档。")
	}
	if len(entries) > 10000 {
		return bad(503, "文档数量超出导入比较预算，请先归档。")
	}
	var scanned int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if !documentID.MatchString(id) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return bad(500, "无法检查已有文档。")
		}
		scanned += info.Size()
		if scanned > 128<<20 {
			return bad(503, "已有文档超出本次导入比较预算，请先归档部分文档。")
		}
		d, err := s.loadLocked(id)
		if err != nil {
			return err
		}
		visit(d)
	}
	return nil
}

func importFingerprint(files []stagedFile) (string, error) {
	ordered := append([]stagedFile{}, files...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Path < ordered[j].Path })
	hash := sha256.New()
	for _, file := range ordered {
		data, err := os.ReadFile(file.Temp)
		if err != nil {
			err = bad(500, "文档读取失败，请重试。")
		}
		if err != nil {
			return "", err
		}
		digest := sha256.Sum256(data)
		encoded, _ := json.Marshal(struct {
			Path string
			Hash string
		}{file.Path, hex.EncodeToString(digest[:])})
		_, _ = hash.Write(encoded)
	}
	if len(files) > 0 && files[0].Decisions != nil {
		options := *files[0].Decisions
		options.RequestID = ""
		options.Paths = append([]importDecision{}, options.Paths...)
		sort.Slice(options.Paths, func(i, j int) bool { return options.Paths[i].Path < options.Paths[j].Path })
		encoded, _ := json.Marshal(options)
		_, _ = hash.Write(encoded)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func (h *handler) importPreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		method(w, "POST")
		return
	}
	if !beginUpload(w) {
		return
	}
	defer endUpload()
	files, _, cleanup, err := h.store.stageUpload(w, r)
	if err != nil {
		respondError(w, err)
		return
	}
	defer cleanup()
	result, err := h.store.prepareImport(files)
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, result.preview)
}

func appendImportWarning(previous []string, value string) []string {
	for _, item := range previous {
		if item == value {
			return previous
		}
	}
	return append(previous, value)
}
