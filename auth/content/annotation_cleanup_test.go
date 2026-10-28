package content

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAnnotationDeleteUnavailableAndReclaimOnlyConfirmedOrphans(t *testing.T) {
	s := testStore(t)
	h := researchHandler(s)
	d := publishedResearchDoc(t, s)
	a := researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
	draft, err := s.Action(d.ID, "unpublish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "DELETE", "/api/annotations/"+a["id"].(string), map[string]int{"version": 2}); w.Code != 409 {
		t.Fatalf("unavailable delete must retain CAS, got %d", w.Code)
	}
	if w := apiCall(h, "DELETE", "/api/annotations/"+a["id"].(string), map[string]int{"version": 1}); w.Code != 200 {
		t.Fatalf("owner cannot remove unavailable annotation: %d", w.Code)
	}
	d, err = s.Action(d.ID, "publish", draft.Version)
	if err != nil {
		t.Fatal(err)
	}
	retained := publishedResearchDoc(t, s)
	researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(retained.ID)))
	if _, err = s.Action(retained.ID, "unpublish", retained.Version); err != nil {
		t.Fatal(err)
	}
	q := TextQuote{Exact: "Published quote."}
	state, err := s.loadResearchLocked()
	if err != nil {
		t.Fatal(err)
	}
	stamp := s.now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	for i := 0; len(state.Annotations) < maxAnnotations; i++ {
		id := strings.Repeat("0", 24) + formatEightHex(i)
		state.Annotations[id] = Annotation{ID: id, DocumentID: strings.Repeat("0", 24) + formatEightHex(100000+i/199), Quote: q, Body: "generated", Color: "mint", Version: 1, CreatedAt: stamp, UpdatedAt: stamp}
	}
	if err = s.saveResearchLocked(state); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)); w.Code != 201 {
		t.Fatalf("confirmed deleted documents permanently consume quota: %d", w.Code)
	}
	state, err = s.loadResearchLocked()
	if err != nil || len(state.Annotations) != 2 {
		t.Fatalf("orphan cleanup removed retained draft or left garbage: %v", err)
	}
	for _, annotation := range state.Annotations {
		if annotation.DocumentID != d.ID && annotation.DocumentID != retained.ID {
			t.Fatal("orphan remained")
		}
	}
}

func formatEightHex(value int) string {
	const digits = "0123456789abcdef"
	result := []byte("00000000")
	for i := 7; i >= 0; i-- {
		result[i] = digits[value&15]
		value >>= 4
	}
	return string(result)
}

func TestAnnotationCleanupDoesNotFollowDocumentSymlink(t *testing.T) {
	s := testStore(t)
	d := publishedResearchDoc(t, s)
	h := researchHandler(s)
	researchData(t, apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)))
	state, _ := s.loadResearchLocked()
	for id, annotation := range state.Annotations {
		annotation.DocumentID = strings.Repeat("e", 32)
		state.Annotations[id] = annotation
	}
	if err := s.saveResearchLocked(state); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "not-present"), filepath.Join(s.root, "documents", strings.Repeat("e", 32)+".json")); err != nil {
		t.Fatal(err)
	}
	if w := apiCall(h, "POST", "/api/annotations", annotationInput(d.ID)); w.Code != 500 {
		t.Fatalf("unsafe entry not rejected: %d", w.Code)
	}
	state, _ = s.loadResearchLocked()
	if len(state.Annotations) != 1 {
		t.Fatal("unsafe path caused destructive cleanup")
	}
}
