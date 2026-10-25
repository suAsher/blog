package content

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var uploadSlot = make(chan struct{}, 1)

type stagedFile struct {
	Path, Temp string
	Size       int64
}

func beginUpload(w http.ResponseWriter) bool {
	select {
	case uploadSlot <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "2")
		respondError(w, bad(429, "另一个导入正在进行，请稍后重试。"))
		return false
	}
}
func endUpload() { <-uploadSlot }

func safeUploadPath(value string) (string, error) {
	decoded, err := url.PathUnescape(escapeInvalidPercents(value))
	if err != nil || !utf8.ValidString(value) || len(value) == 0 || len(value) > 2048 || strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\\:") || strings.ContainsAny(decoded, "\\:") {
		return "", bad(400, "上传路径无效，不能包含绝对路径或目录跳转。")
	}
	for _, part := range strings.Split(decoded, "/") {
		if part == ".." || part == "" || part == "." || strings.IndexFunc(part, unicode.IsControl) >= 0 {
			return "", bad(400, "上传路径无效，不能包含绝对路径或目录跳转。")
		}
	}
	if path.Clean(value) != value {
		return "", bad(400, "上传路径无效。")
	}
	return value, nil
}

// Filesystem names may contain a literal percent sign. Preserve it while still
// decoding valid %xx sequences for traversal/control-character validation.
func escapeInvalidPercents(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] == '%' {
			valid := false
			if i+2 < len(value) {
				_, err := strconv.ParseUint(value[i+1:i+3], 16, 8)
				valid = err == nil
			}
			if !valid {
				out.WriteString("%25")
				continue
			}
		}
		out.WriteByte(value[i])
	}
	return out.String()
}

func hiddenPath(value string) bool {
	for _, part := range strings.Split(value, "/") {
		if strings.HasPrefix(part, ".") || strings.EqualFold(part, "node_modules") {
			return true
		}
	}
	switch strings.ToLower(path.Ext(value)) {
	case ".key", ".pem", ".p12", ".pfx", ".env":
		return true
	}
	return false
}

func uploadReadError(err error) error {
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return bad(413, "一批上传不能超过 32 MB，请拆分后重试。")
	}
	return bad(400, "上传内容不完整，请重新选择文件。")
}

func (s *Store) stageUpload(w http.ResponseWriter, r *http.Request) ([]stagedFile, []string, func(), error) {
	noop := func() {}
	if r.ContentLength > MaxUploadBytes {
		return nil, nil, noop, bad(413, "一批上传不能超过 32 MB。")
	}
	reservation := r.ContentLength
	if reservation < 0 {
		reservation = MaxUploadBytes
	}
	releaseSpace, err := s.reserveSpace(reservation)
	if err != nil {
		return nil, nil, noop, err
	}
	defer releaseSpace()
	r.Body = http.MaxBytesReader(w, r.Body, MaxUploadBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, nil, noop, bad(400, "请通过文件上传表单提交。")
	}
	dir, err := os.MkdirTemp(filepath.Join(s.root, "tmp"), "import-")
	if err != nil {
		return nil, nil, noop, bad(500, "暂时无法创建上传临时目录。")
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	success := false
	defer func() {
		if !success {
			cleanup()
		}
	}()
	files := []stagedFile{}
	var paths []string
	pathsSeen := false
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, noop, uploadReadError(err)
		}
		if part.FormName() == "paths" {
			if pathsSeen {
				part.Close()
				return nil, nil, noop, bad(400, "文件路径清单重复。")
			}
			pathsSeen = true
			data, readErr := io.ReadAll(io.LimitReader(part, (512<<10)+1))
			part.Close()
			if readErr != nil {
				return nil, nil, noop, uploadReadError(readErr)
			}
			if len(data) > 512<<10 || json.Unmarshal(data, &paths) != nil {
				return nil, nil, noop, bad(400, "文件路径清单无效。")
			}
			continue
		}
		if part.FormName() != "files" || part.FileName() == "" {
			part.Close()
			return nil, nil, noop, bad(400, "文件表单字段无效。")
		}
		// multipart.Part.FileName deliberately strips directory components. Check
		// the original header as well so hostile paths are rejected, not hidden.
		_, disposition, dispositionErr := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
		if dispositionErr != nil {
			part.Close()
			return nil, nil, noop, bad(400, "文件名称格式无效。")
		}
		if _, err := safeUploadPath(disposition["filename"]); err != nil {
			part.Close()
			return nil, nil, noop, err
		}
		if len(files) >= 500 {
			part.Close()
			return nil, nil, noop, bad(413, "一批最多上传 500 个文件。")
		}
		name := filepath.Join(dir, strconv.Itoa(len(files)))
		file, err := os.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			part.Close()
			return nil, nil, noop, bad(500, "暂时无法保存上传内容。")
		}
		size, readErr := io.Copy(file, io.LimitReader(part, MaxImageBytes+1))
		closeErr := file.Close()
		original := part.FileName()
		part.Close()
		if readErr != nil {
			return nil, nil, noop, uploadReadError(readErr)
		}
		if closeErr != nil {
			return nil, nil, noop, bad(500, "上传内容未完整保存。")
		}
		if size > MaxImageBytes {
			return nil, nil, noop, bad(413, "单文件超过 8 MB，请压缩后上传。")
		}
		files = append(files, stagedFile{Path: original, Temp: name, Size: size})
	}
	if pathsSeen && len(paths) != len(files) {
		return nil, nil, noop, bad(400, "文件与路径清单数量不一致。")
	}
	seen := map[string]bool{}
	for i := range files {
		if pathsSeen {
			files[i].Path = paths[i]
		}
		value, err := safeUploadPath(files[i].Path)
		if err != nil {
			return nil, nil, noop, err
		}
		if seen[value] {
			return nil, nil, noop, bad(400, "同一批上传不能包含重复路径。")
		}
		seen[value] = true
		files[i].Path = value
	}
	success = true
	return files, paths, cleanup, nil
}
