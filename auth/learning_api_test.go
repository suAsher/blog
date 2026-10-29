package main

import (
	"net/http/httptest"
	"testing"

	"asher.space/auth/content"
)

func TestLearningRoutesKeepPrivateBoundaryAndRateBudget(t *testing.T) {
	s := testServer(t)
	store, err := content.NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.api = content.NewHandler(store)
	document, err := store.Create(content.Content{
		Title: "演示 · 研究接口验收", Source: "这是独立生成的测试正文。", Date: "2026-10-28", Tags: []string{},
	}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Action(document.ID, "publish", document.Version); err != nil {
		t.Fatal(err)
	}
	paths := []string{
		"/api/learning-paths",
	}
	for _, path := range append(append([]string{}, paths...), "/api/learning-paths/"+document.ID) {
		for _, verb := range []string{"GET", "POST", "PUT", "DELETE"} {
			if response := call(s, verb, path, "{}", nil); response.Code != 401 {
				t.Fatalf("anonymous %s %s returned %d", verb, path, response.Code)
			}
		}
	}
	cookie := login(t, s, false)
	for _, path := range paths {
		response := call(s, "GET", path, "", cookie)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("private read %s status=%d cache=%q", path, response.Code, response.Header().Get("Cache-Control"))
		}
	}
	for _, path := range append(append([]string{}, paths...), "/api/learning-paths/"+document.ID) {
		request := httptest.NewRequest("POST", "https://space.example"+path, nil)
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
	for _, path := range paths {
		if response := call(s, "GET", path, "", cookie); response.Code != 429 {
			t.Fatalf("research route %s bypasses rate budget", path)
		}
	}
}
