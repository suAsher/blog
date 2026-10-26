package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestReadingAndReviewAPIsKeepAuthOriginAndRateBoundaries(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	for _, path := range []string{"/api/reading-state", "/api/reviews"} {
		if w := call(s, "GET", path, "", nil); w.Code != 401 {
			t.Fatal("anonymous private reading state exposed")
		}
	}
	cookie := login(t, s, false)
	r := httptest.NewRequest("POST", "https://space.example/api/reading-state", nil)
	r.AddCookie(cookie)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("reading state write bypassed origin protection")
	}
	for _, path := range []string{"/api/reading-state", "/api/reviews"} {
		if w := call(s, "GET", path, "", cookie); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("authenticated API unavailable/cacheable")
		}
	}
	s.mu.Lock()
	for ip, entry := range s.apiRequests {
		entry.count = 600
		s.apiRequests[ip] = entry
	}
	s.mu.Unlock()
	for _, path := range []string{"/api/reading-state", "/api/reviews"} {
		if w := call(s, "GET", path, "", cookie); w.Code != 429 {
			t.Fatal("reading route bypasses shared rate budget")
		}
	}
}
