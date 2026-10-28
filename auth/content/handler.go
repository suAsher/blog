package content

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

type handler struct{ store *Store }

func NewHandler(s *Store) http.Handler { return &handler{store: s} }
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": data})
}
func respondError(w http.ResponseWriter, err error) {
	status := 500
	message := "操作未完成，请稍后重试。"
	code := ""
	var known *apiError
	if errors.As(err, &known) {
		status = known.Status
		message = known.Message
		code = known.Code
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "message": message, "code": code})
}
func method(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	respondError(w, bad(405, "请求方式无效。"))
}
func decodeJSON(w http.ResponseWriter, r *http.Request, value any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return bad(415, "请使用 JSON 提交内容。")
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSourceBytes*2+16384)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		return bad(400, "提交内容格式无效或超出大小限制。")
	}
	return nil
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	path := r.URL.Path
	switch {
	case path == "/api/annotations" || strings.HasPrefix(path, "/api/annotations/"):
		h.annotations(w, r, path)
	case path == "/api/workspaces" || strings.HasPrefix(path, "/api/workspaces/"):
		h.workspaces(w, r, path)
	case path == "/api/import/preview":
		h.importPreview(w, r)
	case path == "/api/import/reports":
		h.importReports(w, r)
	case path == "/api/offline-revisions":
		h.offlineRevisions(w, r)
	case path == "/api/reading-state":
		h.readingState(w, r)
	case path == "/api/reviews":
		h.reviews(w, r)
	case path == "/api/graph" || path == "/api/link-targets" || path == "/api/random":
		h.knowledge(w, r, path)
	case path == "/api/dashboard":
		if r.Method != "GET" && r.Method != "HEAD" {
			method(w, "GET, HEAD")
			return
		}
		result, err := h.store.Dashboard()
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, result)
	case path == "/api/documents":
		h.documents(w, r)
	case path == "/api/preview":
		h.preview(w, r)
	case path == "/api/import":
		if r.Method != "POST" {
			method(w, "POST")
			return
		}
		h.store.importHTTP(w, r)
	case path == "/api/assets":
		if r.Method != "POST" {
			method(w, "POST")
			return
		}
		h.store.assetsHTTP(w, r, "")
	case strings.HasPrefix(path, "/api/assets/"):
		if r.Method != "GET" && r.Method != "HEAD" {
			method(w, "GET, HEAD")
			return
		}
		h.store.assetsHTTP(w, r, strings.TrimPrefix(path, "/api/assets/"))
	case strings.HasPrefix(path, "/api/documents/"):
		h.document(w, r, strings.TrimPrefix(path, "/api/documents/"))
	default:
		respondError(w, bad(404, "接口不存在。"))
	}
}

func (h *handler) documents(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET", "HEAD":
		q := r.URL.Query()
		limit := 24
		offset := 0
		var err error
		if q.Has("limit") {
			limit, err = strconv.Atoi(q.Get("limit"))
			if err != nil || limit < 1 || limit > 1000 {
				respondError(w, bad(400, "分页数量应为 1 至 1000。"))
				return
			}
		}
		if q.Has("offset") {
			offset, err = strconv.Atoi(q.Get("offset"))
			if err != nil || offset < 0 {
				respondError(w, bad(400, "分页起点无效。"))
				return
			}
		}
		result, err := h.store.List(ListOptions{Status: q.Get("status"), Query: q.Get("q"), Tag: q.Get("tag"), Category: q.Get("category"), Limit: limit, Offset: offset})
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, result)
	case "POST":
		var value contentRequest
		if err := decodeJSON(w, r, &value); err != nil {
			respondError(w, err)
			return
		}
		c, _, err := value.content()
		if err != nil {
			respondError(w, err)
			return
		}
		document, err := h.store.Create(c, "", nil)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 201, document)
	default:
		method(w, "GET, HEAD, POST")
	}
}

func (h *handler) document(w http.ResponseWriter, r *http.Request, path string) {
	parts := strings.Split(path, "/")
	if len(parts) < 1 || len(parts) > 2 || !documentID.MatchString(parts[0]) {
		respondError(w, bad(404, "文档不存在。"))
		return
	}
	id := parts[0]
	if len(parts) == 2 {
		if parts[1] == "history" {
			h.documentHistory(w, r, id)
			return
		}
		if parts[1] == "links" {
			h.documentLinks(w, r, id)
			return
		}
		if parts[1] == "export" {
			if r.Method != "GET" {
				method(w, "GET")
				return
			}
			h.store.exportHTTP(w, r, id)
			return
		}
		if r.Method != "POST" {
			method(w, "POST")
			return
		}
		var value struct {
			Version int `json:"version"`
		}
		if err := decodeJSON(w, r, &value); err != nil {
			respondError(w, err)
			return
		}
		document, err := h.store.Action(id, parts[1], value.Version)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, document)
		return
	}
	switch r.Method {
	case "GET", "HEAD":
		document, err := h.store.Get(id, r.URL.Query().Get("view"))
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, document)
	case "PUT":
		var value struct {
			contentRequest
			Version int `json:"version"`
		}
		if err := decodeJSON(w, r, &value); err != nil {
			respondError(w, err)
			return
		}
		c, present, err := value.content()
		if err != nil {
			respondError(w, err)
			return
		}
		document, err := h.store.update(id, c, value.Version, present)
		if err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, document)
	case "DELETE":
		var value struct {
			Version int `json:"version"`
		}
		if err := decodeJSON(w, r, &value); err != nil {
			respondError(w, err)
			return
		}
		if err := h.store.Delete(id, value.Version); err != nil {
			respondError(w, err)
			return
		}
		respond(w, 200, map[string]bool{"deleted": true})
	default:
		method(w, "GET, HEAD, PUT, DELETE")
	}
}

func (h *handler) preview(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		method(w, "POST")
		return
	}
	var value struct {
		Source     string `json:"source"`
		DocumentID string `json:"documentId"`
	}
	if err := decodeJSON(w, r, &value); err != nil {
		respondError(w, err)
		return
	}
	if err := validateSource(value.Source); err != nil {
		respondError(w, err)
		return
	}
	var aliases map[string]string
	if value.DocumentID != "" {
		h.store.mu.RLock()
		d, err := h.store.loadLocked(value.DocumentID)
		h.store.mu.RUnlock()
		if err != nil {
			respondError(w, err)
			return
		}
		aliases = d.Aliases
	}
	h.store.mu.RLock()
	var resolver wikiResolver
	if strings.Contains(value.Source, "[[") {
		resolver = h.store.wikiResolverLocked("working")
	}
	result, err := renderMarkdownResolved(value.Source, aliases, resolver)
	h.store.mu.RUnlock()
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, result)
}
