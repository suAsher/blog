package content

import (
	"errors"
	"io"
	"mime"
	"net/http"
)

type researchDelete struct {
	Version int64 `json:"version"`
}

func researchConflict() error {
	return &apiError{Status: 409, Code: "VERSION_CONFLICT", Message: "研究记录已在其他页面更新，请重新加载后重试。"}
}
func decodeResearch(w http.ResponseWriter, r *http.Request, value any, limit int64) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return bad(415, "请使用 JSON 提交研究记录。")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			return bad(413, "研究请求超出大小预算。")
		}
		return bad(400, "研究请求无法读取。")
	}
	return strictResearchJSON(data, value)
}
