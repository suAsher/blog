package content

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	_ "golang.org/x/image/webp"
)

var assetName = regexp.MustCompile(`^[a-f0-9]{64}\.(png|jpg|gif|webp)$`)
var imageMIMEs = map[string]string{"png": "image/png", "jpg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}

type assetInfo struct {
	URL  string `json:"url"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func inspectImage(name string) (string, error) {
	file, err := os.Open(name)
	if err != nil {
		return "", bad(500, "无法读取待上传图片。")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() > MaxImageBytes {
		return "", bad(413, "单张图片不能超过 8 MB。")
	}
	config, format, err := image.DecodeConfig(file)
	if err != nil || config.Width < 1 || config.Height < 1 || int64(config.Width)*int64(config.Height) > 40000000 {
		return "", bad(400, "图片格式无效或尺寸过大；支持 PNG、JPEG、GIF、WebP。")
	}
	if format == "jpeg" {
		format = "jpg"
	}
	if _, ok := imageMIMEs[format]; !ok {
		return "", bad(400, "仅支持 PNG、JPEG、GIF、WebP 图片。")
	}
	return format, nil
}

func (s *Store) saveAsset(staged, original string) (assetInfo, error) {
	ext, err := inspectImage(staged)
	if err != nil {
		return assetInfo{}, err
	}
	file, err := os.Open(staged)
	if err != nil {
		return assetInfo{}, bad(500, "无法读取待上传图片。")
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return assetInfo{}, bad(500, "图片读取不完整，请重试。")
	}
	name := hex.EncodeToString(hash.Sum(nil)) + "." + ext
	target := filepath.Join(s.root, "assets", name)
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, err := os.Lstat(target); err == nil {
		if !existing.Mode().IsRegular() || existing.Size() != size {
			return assetInfo{}, bad(500, "已有图片记录异常，请检查备份。")
		}
		verified, err := os.Open(target)
		if err != nil {
			return assetInfo{}, bad(500, "已有图片暂时无法读取。")
		}
		check := sha256.New()
		_, readErr := io.Copy(check, verified)
		closeErr := verified.Close()
		if readErr != nil || closeErr != nil || hex.EncodeToString(check.Sum(nil)) != strings.TrimSuffix(name, "."+ext) {
			return assetInfo{}, bad(500, "已有图片内容校验失败，请检查备份。")
		}
		return assetInfo{URL: "/api/assets/" + name, Name: original, Size: size}, nil
	} else if !os.IsNotExist(err) {
		return assetInfo{}, bad(500, "无法检查图片存储。")
	}
	releaseSpace, err := s.reserveSpace(size)
	if err != nil {
		return assetInfo{}, err
	}
	defer releaseSpace()
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return assetInfo{}, bad(500, "无法保存图片。")
	}
	temp, err := os.CreateTemp(filepath.Join(s.root, "assets"), ".write-")
	if err != nil {
		return assetInfo{}, bad(500, "图片尚未保存，请重试。")
	}
	defer os.Remove(temp.Name())
	_, err = io.Copy(temp, file)
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err != nil || closeErr != nil {
		return assetInfo{}, bad(500, "图片尚未完整保存，请重试。")
	}
	if os.Rename(temp.Name(), target) != nil {
		return assetInfo{}, bad(500, "图片尚未保存，请重试。")
	}
	dir, err := os.Open(filepath.Join(s.root, "assets"))
	if err != nil {
		return assetInfo{}, bad(500, "无法确认图片保存状态。")
	}
	defer dir.Close()
	if dir.Sync() != nil {
		return assetInfo{}, bad(500, "无法确认图片保存状态。")
	}
	return assetInfo{URL: "/api/assets/" + name, Name: original, Size: size}, nil
}

func (s *Store) assetsHTTP(w http.ResponseWriter, r *http.Request, id string) {
	if id != "" {
		if !assetName.MatchString(id) {
			respondError(w, bad(404, "图片不存在。"))
			return
		}
		file, err := openAsset(s.root, id)
		if err != nil {
			respondError(w, bad(404, "图片不存在。"))
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			respondError(w, bad(500, "图片暂时无法读取。"))
			return
		}
		w.Header().Set("Content-Type", imageMIMEs[strings.TrimPrefix(filepath.Ext(id), ".")])
		w.Header().Set("Content-Disposition", "inline")
		http.ServeContent(w, r, id, info.ModTime(), file)
		return
	}
	if !beginUpload(w) {
		return
	}
	defer endUpload()
	files, _, cleanup, err := s.stageUpload(w, r)
	if err != nil {
		respondError(w, err)
		return
	}
	defer cleanup()
	if len(files) == 0 {
		respondError(w, bad(400, "请选择图片文件。"))
		return
	}
	assets := []assetInfo{}
	for _, file := range files {
		if hiddenPath(file.Path) || !imageExtension(file.Path) {
			respondError(w, bad(400, "图片仅支持 PNG、JPEG、GIF、WebP，不接受 SVG 或隐藏文件。"))
			return
		}
		if _, err := inspectImage(file.Temp); err != nil {
			respondError(w, err)
			return
		}
	}
	for _, file := range files {
		asset, err := s.saveAsset(file.Temp, file.Path)
		if err != nil {
			respondError(w, err)
			return
		}
		assets = append(assets, asset)
	}
	respond(w, 200, map[string]any{"assets": assets, "quota": s.quota()})
}

func openAsset(root, id string) (*os.File, error) {
	if !assetName.MatchString(id) {
		return nil, errors.New("invalid asset")
	}
	name := filepath.Join(root, "assets", id)
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("asset unavailable")
	}
	return os.Open(name)
}

func imageExtension(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}
