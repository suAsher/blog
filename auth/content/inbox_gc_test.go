package content

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func inboxStateBytes(t *testing.T, s *Store) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.root, "state", "inbox.json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInboxGCReleasesPermanentlyDeletedEntries(t *testing.T) {
	s := testStore(t)
	doc := mustCreate(t, s, input("new material"))
	state := newInboxFile()
	for i := range maxInboxEntries {
		state.Entries[fmt.Sprintf("%032x", i)] = inboxEntry{Stage: "verified", UpdatedAt: "2026-11-06T00:00:00Z"}
	}
	if err := s.saveInboxLocked(state); err != nil {
		t.Fatal(err)
	}
	w := apiCall(inboxTestHandler(s), "PUT", "/api/inbox/batch", inboxBatch(0, "organized", doc.ID))
	if w.Code != 200 {
		t.Fatalf("deleted entries exhausted the quota: %d %s", w.Code, w.Body.String())
	}
	current, err := s.loadInboxLocked()
	if err != nil || current.Version != 1 || len(current.Entries) != 1 || current.Entries[doc.ID].Stage != "organized" {
		t.Fatal(current, err)
	}
}

func TestInboxGCPreservesTrashAndDoesNotMutateExistingDocuments(t *testing.T) {
	s := testStore(t)
	doc := mustCreate(t, s, input("new material"))
	trash := mustCreate(t, s, input("recoverable trash"))
	if _, err := s.Action(trash.ID, "trash", trash.Version); err != nil {
		t.Fatal(err)
	}
	state := newInboxFile()
	entry := inboxEntry{Stage: "verified", UpdatedAt: "2026-11-06T00:00:00Z"}
	state.Entries[trash.ID], state.Entries["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] = entry, entry
	if err := s.saveInboxLocked(state); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(s.root, "documents", trash.ID+".json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	w := apiCall(inboxTestHandler(s), "PUT", "/api/inbox/batch", inboxBatch(0, "organized", doc.ID))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	current, err := s.loadInboxLocked()
	if err != nil || len(current.Entries) != 2 || current.Entries[trash.ID] != entry {
		t.Fatal(current, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("GC changed trash document", err)
	}
}

func TestInboxGCOnlyCommitsWithSuccessfulCASMutation(t *testing.T) {
	for _, failure := range []string{"conflict", "disk", "reference", "symlink", "directory", "oversize"} {
		t.Run(failure, func(t *testing.T) {
			s := testStore(t)
			doc := mustCreate(t, s, input("original"))
			state := newInboxFile()
			state.Version = 1
			missing, unsafe := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
			entry := inboxEntry{Stage: "organized", UpdatedAt: "2026-11-06T00:00:00Z"}
			state.Entries[missing] = entry
			version, target, expected := int64(1), doc.ID, 500
			switch failure {
			case "conflict":
				version, expected = 0, 409
			case "disk":
				s.freeBytes = func() (int64, error) { return ReserveBytes - 1, nil }
				expected = 507
			case "reference":
				target, expected = missing, 404
			default:
				state.Entries[unsafe] = entry
				path := filepath.Join(s.root, "documents", unsafe+".json")
				var err error
				switch failure {
				case "symlink":
					err = os.Symlink(filepath.Join(s.root, "documents", doc.ID+".json"), path)
				case "directory":
					err = os.Mkdir(path, 0700)
				case "oversize":
					var file *os.File
					file, err = os.Create(path)
					if err == nil {
						err = file.Truncate(maxRecordBytes + 1)
						file.Close()
					}
				}
				if err != nil {
					t.Fatal(err)
				}
			}
			// Seed before applying the simulated disk shortage.
			free := s.freeBytes
			s.freeBytes = func() (int64, error) { return 1 << 40, nil }
			if err := s.saveInboxLocked(state); err != nil {
				t.Fatal(err)
			}
			s.freeBytes = free
			before := inboxStateBytes(t, s)
			w := apiCall(inboxTestHandler(s), "PUT", "/api/inbox/batch", inboxBatch(version, "verified", target))
			if w.Code != expected {
				t.Fatal(w.Code, w.Body.String())
			}
			if !bytes.Equal(before, inboxStateBytes(t, s)) {
				t.Fatal("failed mutation persisted GC")
			}
		})
	}
}
