package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestOfflineRevisionChecksKeepAuthAndSharedRateBoundaries(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	path := "/api/offline-revisions?ids=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if w := call(s, "GET", path, "", nil); w.Code != 401 {
		t.Fatal("anonymous version availability exposed")
	}
	cookie := login(t, s, false)
	if w := call(s, "GET", path, "", cookie); w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private revision check unavailable/cacheable")
	}
	r := httptest.NewRequest("POST", "https://space.example"+path, nil)
	r.AddCookie(cookie)
	r.Header.Set("Origin", "https://evil.example")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("new route bypassed shared origin protection")
	}
	s.mu.Lock()
	for ip, entry := range s.apiRequests {
		entry.count = 600
		s.apiRequests[ip] = entry
	}
	s.mu.Unlock()
	if w := call(s, "GET", path, "", cookie); w.Code != 429 {
		t.Fatal("revision checks bypass shared API rate limit")
	}
}
