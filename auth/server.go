package main

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type authServer struct {
	credentials credentials
	mu          sync.Mutex
	sessions    map[[32]byte]time.Time
	attempts    map[string]attempt
	hashSlots   chan struct{}
	now         func() time.Time
	api         http.Handler
	apiRequests map[string]attempt
}

func newAuthServer(c credentials) *authServer {
	return &authServer{credentials: c, sessions: make(map[[32]byte]time.Time),
		attempts: make(map[string]attempt), apiRequests: make(map[string]attempt), hashSlots: make(chan struct{}, 4), now: time.Now}
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]any{"ok": false, "message": message})
}

func (s *authServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.serveContent(w, r)
		return
	}
	if r.URL.Path == "/healthz" {
		w.WriteHeader(204)
		return
	}
	switch r.URL.Path {
	case "/auth/login", "/auth/logout":
		if r.Method != "POST" {
			w.Header().Set("Allow", "POST")
			fail(w, 405, "请使用登录表单")
			return
		}
		if r.Header.Get("Origin") != s.credentials.origin {
			fail(w, 403, "请求来源无效，请刷新页面后重试")
			return
		}
		if r.URL.Path == "/auth/login" {
			s.login(w, r)
		} else {
			s.logout(w, r)
		}
	case "/auth/session", "/auth/verify":
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			fail(w, 405, "请求方式无效")
			return
		}
		valid := s.authenticated(r)
		if r.URL.Path == "/auth/session" {
			respond(w, 200, map[string]bool{"authenticated": valid})
			return
		}
		if valid {
			w.WriteHeader(204)
			return
		}
		next := safeNext(r.Header.Get("X-Forwarded-Uri"))
		w.Header().Set("Location", "/login/?next="+url.QueryEscape(next))
		w.WriteHeader(http.StatusFound)
	default:
		fail(w, 404, "页面不存在")
	}
}

func (s *authServer) login(w http.ResponseWriter, r *http.Request) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 415, "请使用登录表单提交")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
		Next     string `json:"next"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || len(input.Username) == 0 || len(input.Username) > 128 || len(input.Password) == 0 || len(input.Password) > 1024 {
		fail(w, 400, "请填写有效的账号和密码")
		return
	}
	ip := clientIP(r)
	if !s.allowAttempt(ip) {
		w.Header().Set("Retry-After", "300")
		fail(w, 429, "尝试次数过多，请稍后再试")
		return
	}
	select {
	case s.hashSlots <- struct{}{}:
		defer func() { <-s.hashSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "登录请求较多，请稍后再试")
		return
	}
	if !s.credentials.matches(input.Username, input.Password) {
		fail(w, 401, "账号或密码不正确")
		return
	}
	s.mu.Lock()
	delete(s.attempts, ip)
	s.mu.Unlock()
	s.revoke(r)
	cookie, err := s.mintSession(input.Remember)
	if err != nil {
		fail(w, 503, "暂时无法创建会话，请稍后重试")
		return
	}
	http.SetCookie(w, cookie)
	respond(w, 200, map[string]any{"ok": true, "redirect": safeNext(input.Next)})
}

func (s *authServer) logout(w http.ResponseWriter, r *http.Request) {
	s.revoke(r)
	// Clear the HTTP cache while preserving local bookmarks and reading records.
	w.Header().Set("Clear-Site-Data", `"cache"`)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1})
	respond(w, 200, map[string]bool{"ok": true})
}
