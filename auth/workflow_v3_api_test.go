package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestWorkflowV3PrivateBoundaryAndRateBudget(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	reads := []string{"/api/inbox", "/api/search/passages?q=example"}
	writes := []string{"/api/inbox/batch", "/api/inbox/views"}
	for _, path := range append(append([]string{}, reads...), writes...) {
		for _, verb := range []string{"GET", "PUT", "POST", "DELETE"} {
			if response := call(s, verb, path, "{}", nil); response.Code != 401 {
				t.Fatalf("anonymous %s %s returned %d", verb, path, response.Code)
			}
		}
	}
	cookie := login(t, s, false)
	for _, path := range reads {
		response := call(s, "GET", path, "", cookie)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("private read %s status=%d cache=%q", path, response.Code, response.Header().Get("Cache-Control"))
		}
	}
	for _, path := range writes {
		request := httptest.NewRequest("PUT", "https://space.example"+path, nil)
		request.AddCookie(cookie)
		request.Header.Set("Origin", "https://evil.invalid")
		response := httptest.NewRecorder()
		s.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("cross-origin write accepted for %s", path)
		}
	}
	s.mu.Lock()
	for ip, entry := range s.apiRequests {
		entry.count = 600
		s.apiRequests[ip] = entry
	}
	s.mu.Unlock()
	for _, path := range append(append([]string{}, reads...), writes...) {
		if response := call(s, "GET", path, "", cookie); response.Code != 429 {
			t.Fatalf("workflow route %s bypasses shared rate budget", path)
		}
	}
}
