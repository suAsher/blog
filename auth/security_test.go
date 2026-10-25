package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfigurationValidation(t *testing.T) {
	valid := map[string]any{"origin": "https://space.example", "username": "asher",
		"salt":          base64.StdEncoding.EncodeToString([]byte("sixteen-byte-salt")),
		"password_hash": base64.StdEncoding.EncodeToString(make([]byte, 32)), "iterations": 600000}
	path := filepath.Join(t.TempDir(), "verifier.json")
	write := func(values map[string]any) {
		t.Helper()
		data, _ := json.Marshal(values)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(valid)
	c, err := loadCredentials(path)
	if err != nil || c.origin != "https://space.example" || c.username != "asher" {
		t.Fatal("valid config rejected")
	}
	for _, patch := range []map[string]any{
		{"origin": "http://space.example"}, {"origin": "https://user:pass@space.example"},
		{"origin": "https://space.example/path"}, {"origin": "https://space.example/?q=x"},
		{"origin": "https://space.example/#x"}, {"origin": "://bad"},
		{"username": ""}, {"username": "a\nb"}, {"username": strings.Repeat("a", 129)},
		{"salt": "invalid"}, {"salt": base64.StdEncoding.EncodeToString([]byte("short"))},
		{"password_hash": "invalid"}, {"password_hash": base64.StdEncoding.EncodeToString([]byte("short"))},
		{"iterations": 100}, {"iterations": 3000000}, {"unknown": true},
	} {
		candidate := make(map[string]any, len(valid)+1)
		for key, value := range valid {
			candidate[key] = value
		}
		for key, value := range patch {
			candidate[key] = value
		}
		write(candidate)
		if _, err := loadCredentials(path); err == nil {
			t.Fatalf("invalid configuration accepted: %v", patch)
		}
	}
	if _, err := loadCredentials(path + "-missing"); err == nil {
		t.Fatal("missing config accepted")
	}
	_ = os.WriteFile(path, []byte("{"), 0600)
	if _, err := loadCredentials(path); err == nil {
		t.Fatal("malformed JSON accepted")
	}
}

func TestHTTPIntegration(t *testing.T) {
	s := testServer(t)
	host := httptest.NewTLSServer(s)
	defer host.Close()
	s.credentials.origin = host.URL
	client := host.Client()
	client.Jar, _ = cookiejar.New(nil)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request, _ := http.NewRequest("POST", host.URL+"/auth/login", strings.NewReader(`{"username":"asher","password":"test-only-password","next":"/library/"}`))
	request.Header.Set("Origin", host.URL)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("HTTPS login %d", response.StatusCode)
	}
	verify, err := client.Get(host.URL + "/auth/verify")
	if err != nil {
		t.Fatal(err)
	}
	defer verify.Body.Close()
	if verify.StatusCode != 204 {
		t.Fatal("HTTPS cookie authentication failed")
	}
}

func TestRequestLimitsAndMethods(t *testing.T) {
	s := testServer(t)
	for _, body := range []string{`{"username":"asher","password":"` + strings.Repeat("x", 5000) + `"}`, `{"username":"","password":"x"}`, `{"username":"asher","password":""}`} {
		if got := call(s, "POST", "/auth/login", body, nil).Code; got != 400 {
			t.Fatalf("oversized/missing input %d", got)
		}
	}
	r := httptest.NewRequest("POST", "https://space.example/auth/login", strings.NewReader("x"))
	r.Header.Set("Origin", "https://space.example")
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 415 {
		t.Fatal("non-JSON login accepted")
	}
	if got := call(s, "POST", "/auth/verify", "", nil).Code; got != 405 {
		t.Fatal("verify POST accepted")
	}
	if got := call(s, "GET", "/healthz", "", nil).Code; got != 204 {
		t.Fatal("health unavailable")
	}
	for _, value := range []string{"short", strings.Repeat("!", 43), strings.Repeat("a", 44)} {
		if got := call(s, "GET", "/auth/verify", "", &http.Cookie{Name: cookieName, Value: value}).Code; got != 302 {
			t.Fatal("invalid cookie accepted")
		}
	}
	for i := 0; i < cap(s.hashSlots); i++ {
		s.hashSlots <- struct{}{}
	}
	if got := call(s, "POST", "/auth/login", `{"username":"asher","password":"test-only-password"}`, nil).Code; got != 429 {
		t.Fatal("hash concurrency not bounded")
	}
}

func TestSessionBoundAndIPLimits(t *testing.T) {
	s := testServer(t)
	now := time.Now()
	s.now = func() time.Time { return now }
	old, err := s.mintSession(false)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	for i := 0; i < 256; i++ {
		if _, err := s.mintSession(false); err != nil {
			t.Fatal(err)
		}
	}
	if got := call(s, "GET", "/auth/verify", "", old).Code; got != 302 {
		t.Fatal("oldest session should be evicted")
	}
	if len(s.sessions) > 256 {
		t.Fatal("session count unbounded")
	}
	now = now.Add(8 * 24 * time.Hour)
	_, _ = s.mintSession(false)
	if len(s.sessions) != 1 {
		t.Fatal("expired sessions not collected")
	}
	for i := 0; i < 5; i++ {
		if !s.allowAttempt("same") {
			t.Fatal("early rate limit")
		}
	}
	if s.allowAttempt("same") {
		t.Fatal("rate limit bypass")
	}
	now = now.Add(6 * time.Minute)
	if !s.allowAttempt("same") {
		t.Fatal("rate limit did not expire")
	}
	r := httptest.NewRequest("GET", "https://space.example/", nil)
	r.RemoteAddr = "198.51.100.3:1234"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if clientIP(r) != "198.51.100.3" {
		t.Fatal("public client spoofed proxy IP")
	}
	r.RemoteAddr = "172.20.0.3:1234"
	if clientIP(r) != "1.2.3.4" {
		t.Fatal("private proxy client IP missing")
	}
	r.Header.Set("X-Forwarded-For", "invalid")
	if clientIP(r) != "172.20.0.3" {
		t.Fatal("invalid client IP accepted")
	}
}
