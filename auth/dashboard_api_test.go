package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestDashboardUsesAuthenticatedAndRateLimitedBoundary(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	if w := call(s, "GET", "/api/dashboard", "", nil); w.Code != 401 {
		t.Fatal("private dashboard visible anonymously")
	}
	cookie := login(t, s, false)
	if w := call(s, "GET", "/api/dashboard", "", cookie); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("authenticated dashboard unavailable")
	}
	r := httptest.NewRequest("POST", "https://space.example/api/dashboard", nil)
	r.AddCookie(cookie)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("new endpoint bypassed Origin protection")
	}
	s.mu.Lock()
	for ip, entry := range s.apiRequests {
		entry.count = 600
		s.apiRequests[ip] = entry
	}
	s.mu.Unlock()
	if w := call(s, "GET", "/api/dashboard", "", cookie); w.Code != 429 {
		t.Fatal("dashboard bypassed shared rate budget")
	}
}
