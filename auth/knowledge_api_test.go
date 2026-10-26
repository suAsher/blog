package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestKnowledgeAPIsKeepAuthenticationOriginAndRateBoundaries(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	paths := []string{"/api/graph", "/api/link-targets", "/api/random", "/api/documents/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/links"}
	for _, path := range paths {
		if w := call(s, "GET", path, "", nil); w.Code != 401 {
			t.Fatal("anonymous knowledge data exposed", path)
		}
	}
	cookie := login(t, s, false)
	for _, path := range paths {
		r := httptest.NewRequest("POST", "https://space.example"+path, nil)
		r.AddCookie(cookie)
		r.Header.Set("Origin", "https://evil.example")
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal("knowledge route bypasses origin boundary")
		}
	}
	if w := call(s, "GET", "/api/graph", "", cookie); w.Code != 200 {
		t.Fatal("authenticated graph unavailable")
	}
	s.mu.Lock()
	for ip, entry := range s.apiRequests {
		entry.count = 600
		s.apiRequests[ip] = entry
	}
	s.mu.Unlock()
	for _, path := range paths {
		if w := call(s, "GET", path, "", cookie); w.Code != 429 {
			t.Fatal("knowledge route bypasses rate budget", path)
		}
	}
}
