package main

import (
	"net/http"
	"time"
)

func (s *authServer) serveContent(w http.ResponseWriter, r *http.Request) {
	if !s.authenticated(r) {
		fail(w, http.StatusUnauthorized, "登录已过期，请重新登录。")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != s.credentials.origin {
		fail(w, http.StatusForbidden, "请求来源无效，请刷新页面后重试。")
		return
	}
	if !s.allowAPI(clientIP(r)) {
		w.Header().Set("Retry-After", "60")
		fail(w, http.StatusTooManyRequests, "请求较多，请稍后再试。")
		return
	}
	if s.api == nil {
		fail(w, http.StatusServiceUnavailable, "文档服务暂时不可用，请稍后重试。")
		return
	}
	s.api.ServeHTTP(w, r)
}

func (s *authServer) allowAPI(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, entry := range s.apiRequests {
		if !now.Before(entry.until) {
			delete(s.apiRequests, key)
		}
	}
	entry, found := s.apiRequests[ip]
	if !found {
		if len(s.apiRequests) >= 1024 {
			return false
		}
		entry = attempt{until: now.Add(time.Minute)}
	}
	if entry.count >= 600 {
		return false
	}
	s.apiRequests[ip] = attempt{count: entry.count + 1, until: entry.until}
	return true
}
