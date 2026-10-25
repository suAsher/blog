package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"time"
)

const cookieName = "__Host-asher_session"

type attempt struct {
	count int
	until time.Time
}

func (s *authServer) mintSession(remember bool) (*http.Cookie, error) {
	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	duration := 12 * time.Hour
	maxAge := 0
	if remember {
		duration = 7 * 24 * time.Hour
		maxAge = int(duration.Seconds())
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, expiry := range s.sessions {
		if !now.Before(expiry) {
			delete(s.sessions, key)
		}
	}
	if len(s.sessions) >= 256 {
		var oldest [32]byte
		var earliest time.Time
		for key, expiry := range s.sessions {
			if earliest.IsZero() || expiry.Before(earliest) {
				oldest = key
				earliest = expiry
			}
		}
		delete(s.sessions, oldest)
	}
	s.sessions[sha256.Sum256([]byte(token))] = now.Add(duration)
	return &http.Cookie{Name: cookieName, Value: token, Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: maxAge}, nil
}

func (s *authServer) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(cookieName)
	if err != nil || len(cookie.Value) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cookie.Value)
	if err != nil || len(decoded) != 32 {
		return false
	}
	key := sha256.Sum256([]byte(cookie.Value))
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, found := s.sessions[key]
	if !found {
		return false
	}
	if !s.now().Before(expiry) {
		delete(s.sessions, key)
		return false
	}
	return true
}

func (s *authServer) revoke(r *http.Request) {
	if cookie, err := r.Cookie(cookieName); err == nil {
		s.mu.Lock()
		delete(s.sessions, sha256.Sum256([]byte(cookie.Value)))
		s.mu.Unlock()
	}
}

func clientIP(r *http.Request) string {
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "unknown"
	}
	// This service has no public port. Only the private reverse proxy may supply IPs.
	if ip := net.ParseIP(remote); ip != nil && (ip.IsPrivate() || ip.IsLoopback()) {
		forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
		if net.ParseIP(forwarded) != nil {
			return forwarded
		}
	}
	return remote
}

func (s *authServer) allowAttempt(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	for key, value := range s.attempts {
		if !now.Before(value.until) {
			delete(s.attempts, key)
		}
	}
	value, found := s.attempts[ip]
	if !found {
		if len(s.attempts) >= 1024 {
			return false
		}
		value = attempt{until: now.Add(5 * time.Minute)}
	}
	if value.count >= 5 {
		return false
	}
	s.attempts[ip] = attempt{count: value.count + 1, until: value.until}
	return true
}
