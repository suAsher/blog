package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestContentAuthenticationBoundary(t *testing.T) {
	s := testServer(t)
	calls := 0
	s.api = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(204) })
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE"} {
		if got := call(s, method, "/api/documents", "{}", nil).Code; got != 401 {
			t.Fatalf("anonymous %s: %d", method, got)
		}
	}
	if calls != 0 {
		t.Fatal("anonymous request reached document storage")
	}
	cookie := login(t, s, false)
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE"} {
		if got := call(s, method, "/api/documents", "{}", cookie).Code; got != 204 {
			t.Fatalf("authenticated %s: %d", method, got)
		}
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		r := httptest.NewRequest(method, "https://space.example/api/documents", nil)
		r.AddCookie(cookie)
		r.Header.Set("Origin", "https://evil.example")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("CSRF %s accepted: %d", method, w.Code)
		}
	}
	if calls != 5 {
		t.Fatal("rejected CSRF reached document storage")
	}
	s.api = nil
	if got := call(s, "GET", "/api/documents", "", cookie).Code; got != 503 {
		t.Fatalf("unavailable content service should fail closed: %d", got)
	}
}

func TestContentRequestRateBound(t *testing.T) {
	s := testServer(t)
	cookie := login(t, s, false)
	s.api = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	now := time.Now()
	s.now = func() time.Time { return now }
	for i := 0; i < 600; i++ {
		if got := call(s, "GET", "/api/documents", "", cookie).Code; got != 204 {
			t.Fatalf("early rate limit at %d: %d", i, got)
		}
	}
	if got := call(s, "GET", "/api/documents", "", cookie).Code; got != 429 {
		t.Fatal("content request rate is unbounded")
	}
	now = now.Add(61 * time.Second)
	if got := call(s, "GET", "/api/documents", "", cookie).Code; got != 204 {
		t.Fatal("request window did not reset")
	}
}
