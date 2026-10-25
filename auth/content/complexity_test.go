package content

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDenseMarkdownIsRejectedBeforePersistence(t *testing.T) {
	for _, source := range []string{
		strings.Repeat("*x* ", 12000),
		strings.Repeat("paragraph\n\n", 6000),
		strings.Repeat("> ", 65) + "nested quote",
		strings.Repeat("<a>", 12000) + strings.Repeat("</a>", 12000),
	} {
		s := testStore(t)
		if _, err := s.Create(input(source), "", nil); err == nil {
			t.Fatal("dense Markdown should be rejected before saving")
		}
		entries, err := os.ReadDir(filepath.Join(s.root, "documents"))
		if err != nil || len(entries) != 0 {
			t.Fatal("rejected Markdown was persisted")
		}
		response := apiCall(NewHandler(s), "POST", "/api/preview", map[string]string{"source": source})
		if response.Code != 400 {
			t.Fatalf("dense preview should fail safely: %d", response.Code)
		}
	}
}

func TestLargeNormalTextAndFencedCodeRemainReadable(t *testing.T) {
	const opening, closing, codeLine = "```text\n", "\n```", "*_[]|` > code\n"
	codeLength := int(MaxSourceBytes) - len(opening) - len(closing)
	code := strings.Repeat(codeLine, codeLength/len(codeLine))
	code += strings.Repeat("x", codeLength-len(code))
	sources := []string{
		strings.Repeat("a", int(MaxSourceBytes)),
		opening + code + closing,
	}
	for _, source := range sources {
		s := testStore(t)
		d := mustCreate(t, s, input(source))
		reloaded, err := s.Get(d.ID, "")
		if err != nil || reloaded.Source != source {
			t.Fatalf("large normal document failed: %v", err)
		}
	}
}

func TestUpdatingToDenseMarkdownKeepsPreviousSavedRevision(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("safe original"))
	if _, err := s.Update(d.ID, input(strings.Repeat("*x* ", 12000)), d.Version); err == nil {
		t.Fatal("dense update accepted")
	}
	current, err := s.Get(d.ID, "")
	if err != nil || current.Source != "safe original" || current.Version != d.Version {
		t.Fatal("rejected update changed the saved document")
	}
}

func TestDenseImportIsReportedWithoutPersistingOrParsingImages(t *testing.T) {
	s := testStore(t)
	source := strings.Repeat("*x* ", 12000)
	w := httptest.NewRecorder()
	NewHandler(s).ServeHTTP(w, uploadRequest(t, "/api/import", []string{"dense.md"}, []uploadTestFile{{"dense.md", []byte(source)}}))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "结构过于密集") {
		t.Fatalf("dense import must report a useful skipped-file reason: %d", w.Code)
	}
	for _, directory := range []string{"documents", "tmp"} {
		entries, err := os.ReadDir(filepath.Join(s.root, directory))
		if err != nil || len(entries) != 0 {
			t.Fatal("dense import left persisted or temporary files")
		}
	}
}

func TestFenceBudgetCannotBeBypassedByMalformedInfo(t *testing.T) {
	dense := strings.Repeat("*x* ", 12000)
	if validateSource("```bad`info\n"+dense) == nil {
		t.Fatal("an invalid fence bypassed the parser budget")
	}
	if validateSource("~~~text\n"+dense+"\n~~~") != nil {
		t.Fatal("valid tilde-fenced code should remain supported")
	}
	if validateSource("```text\ninside\n```\n"+dense) == nil {
		t.Fatal("syntax after a closing fence was not budgeted")
	}
	for _, prefix := range []string{"<!--\n```text\n-->\n", "<div>\n```text\n\n", "<script>\n```text\n</script>\n"} {
		if validateSource(prefix+dense) == nil {
			t.Fatal("a fence inside raw HTML bypassed the parser budget")
		}
	}
}
