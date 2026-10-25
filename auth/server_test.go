package main

import (
	"bytes"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testServer(t *testing.T) *authServer {
	t.Helper()
	salt := []byte("test-salt-for-auth-at-least-16-bytes")
	hash, err := pbkdf2.Key(sha256.New, "test-only-password", salt, 600000, 32)
	if err != nil {
		t.Fatal(err)
	}
	return newAuthServer(credentials{origin: "https://space.example", username: "asher", salt: salt, hash: hash, iterations: 600000})
}

func call(s *authServer, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://space.example"+path, strings.NewReader(body))
	r.Header.Set("Origin", "https://space.example")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Forwarded-Uri", "/articles/?q=hello")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func login(t *testing.T, s *authServer, remember bool) *http.Cookie {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"username": "asher", "password": "test-only-password", "remember": remember, "next": "/articles/?q=hello"})
	w := call(s, "POST", "/auth/login", string(data), nil)
	if w.Code != 200 {
		t.Fatalf("login status %d", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing session cookie")
	}
	return cookies[0]
}

func TestSessionLifecycle(t *testing.T) {
	s := testServer(t)
	w := call(s, "GET", "/auth/verify", "", nil)
	if w.Code != 302 || !strings.HasPrefix(w.Header().Get("Location"), "/login/?next=") {
		t.Fatal("anonymous should redirect to login")
	}
	if w.Header().Get("WWW-Authenticate") != "" {
		t.Fatal("must not trigger native browser dialog")
	}
	cookie := login(t, s, false)
	if cookie.Name != "__Host-asher_session" || !cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.Domain != "" || cookie.MaxAge != 0 {
		t.Fatal("unsafe session cookie")
	}
	if got := call(s, "GET", "/auth/verify", "", cookie).Code; got != 204 {
		t.Fatalf("verify %d", got)
	}
	if w := call(s, "GET", "/auth/session", "", cookie); !strings.Contains(w.Body.String(), `"authenticated":true`) {
		t.Fatal("session missing")
	}
	if got := call(s, "POST", "/auth/logout", "{}", cookie).Code; got != 200 {
		t.Fatalf("logout %d", got)
	}
	if got := call(s, "GET", "/auth/verify", "", cookie).Code; got != 302 {
		t.Fatal("logout must revoke the server session")
	}
	if w := call(s, "GET", "/auth/session", "", cookie); !strings.Contains(w.Body.String(), `"authenticated":false`) {
		t.Fatal("revoked session still active")
	}
}

func TestRememberAndExpiry(t *testing.T) {
	s := testServer(t)
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	cookie := login(t, s, true)
	if cookie.MaxAge != 7*24*3600 {
		t.Fatal("remember duration")
	}
	now = now.Add(7*24*time.Hour + time.Second)
	if got := call(s, "GET", "/auth/verify", "", cookie).Code; got != 302 {
		t.Fatal("expired session accepted")
	}
	if got := call(s, "GET", "/auth/verify", "", &http.Cookie{Name: cookie.Name, Value: cookie.Value + "x"}).Code; got != 302 {
		t.Fatal("tampered token accepted")
	}
}

func TestLoginValidationAndCSRF(t *testing.T) {
	s := testServer(t)
	for _, body := range []string{`{`, `{"username":"asher","password":"wrong"}`, `{"username":"unknown","password":"test-only-password"}`, `{"username":"asher","password":"test-only-password","extra":true}`, `{"username":"asher","password":"test-only-password"} {}`} {
		w := call(s, "POST", "/auth/login", body, nil)
		if w.Code != 400 && w.Code != 401 {
			t.Fatalf("unexpected validation status %d", w.Code)
		}
		if strings.Contains(w.Body.String(), "test-only-password") {
			t.Fatal("password leaked")
		}
	}
	r := httptest.NewRequest("POST", "https://space.example/auth/login", bytes.NewBufferString(`{}`))
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross origin login accepted")
	}
	r = httptest.NewRequest("POST", "https://space.example/auth/logout", nil)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("logout without origin accepted")
	}
	if got := call(s, "GET", "/auth/login", "", nil).Code; got != 405 {
		t.Fatal("login GET accepted")
	}
	if got := call(s, "GET", "/unknown", "", nil).Code; got != 404 {
		t.Fatal("unknown route")
	}
}

func TestRateLimit(t *testing.T) {
	s := testServer(t)
	for i := 0; i < 5; i++ {
		if got := call(s, "POST", "/auth/login", `{"username":"asher","password":"wrong"}`, nil).Code; got != 401 {
			t.Fatalf("attempt %d status %d", i, got)
		}
	}
	w := call(s, "POST", "/auth/login", `{"username":"asher","password":"wrong"}`, nil)
	if w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("missing brute force protection")
	}
}

func TestSafeNext(t *testing.T) {
	for _, next := range []string{"https://evil.example/", "//evil.example/", "/\\evil.example/", "/%5cevil.example/", "/%0d%0aLocation:evil", "/auth/logout", "/login/?next=x", strings.Repeat("x", 3000)} {
		if got := safeNext(next); got != "/" {
			t.Errorf("unsafe redirect accepted: %q", next)
		}
	}
	for _, next := range []string{"/", "/articles/?q=%E7%AC%94%E8%AE%B0", "/articles/note/#section", "/library/"} {
		if safeNext(next) != next {
			t.Errorf("valid path rejected: %s", next)
		}
	}
}
