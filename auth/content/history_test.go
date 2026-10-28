package content

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoryRestoresWorkingWithoutPublishing(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("first"))
	d, err := s.Update(d.ID, input("second"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.History(d.ID)
	if err != nil || len(history.History) != 1 || history.History[0].Revision != 1 {
		t.Fatalf("history=%+v %v", history, err)
	}
	snapshot, err := s.HistoryRevision(d.ID, 1)
	if err != nil || snapshot.Content.Source != "first" {
		t.Fatal(snapshot, err)
	}
	d, err = s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := s.RestoreHistory(d.ID, d.Version, 1)
	if err != nil || restored.Source != "first" || !restored.HasUnpublishedChanges {
		t.Fatal(restored, err)
	}
	live, err := s.Get(d.ID, "published")
	if err != nil || live.Source != "second" {
		t.Fatal("restore replaced published snapshot", err)
	}
	if _, err = s.RestoreHistory(d.ID, d.Version, 1); err == nil {
		t.Fatal("stale restore accepted")
	}
	restarted, err := NewStore(s.root)
	if err != nil {
		t.Fatal(err)
	}
	restored, err = restarted.Get(d.ID, "")
	if err != nil || restored.Source != "first" {
		t.Fatal("restore not durable", err)
	}
}

func TestHistoryNoOpRetentionAndDeletion(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("first"))
	unchanged, err := s.Update(d.ID, input("first"), d.Version)
	if err != nil {
		t.Fatal(err)
	}
	history, err := s.History(d.ID)
	if err != nil || len(history.History) != 0 || unchanged.Version != d.Version {
		t.Fatal("no-op save created a revision", history, err)
	}
	for i := 0; i < maxHistoryEntries+4; i++ {
		d, err = s.Update(d.ID, input(strings.Repeat("a", i+1)), d.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	history, err = s.History(d.ID)
	if err != nil || len(history.History) != maxHistoryEntries {
		t.Fatal("retention unbounded", err)
	}
	if _, err = s.HistoryRevision(d.ID, 1); err == nil {
		t.Fatal("evicted revision available")
	}
	d, err = s.Action(d.ID, "trash", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.RestoreHistory(d.ID, d.Version, history.History[0].Revision); err == nil {
		t.Fatal("history restore bypassed trash")
	}
	if err = s.Delete(d.ID, d.Version); err != nil {
		t.Fatal(err)
	}
	if _, err = s.History(d.ID); err == nil {
		t.Fatal("deleted history survived")
	}
}

func TestStoredHistoryRejectsCorruptionAndKeepsLegacy(t *testing.T) {
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) {
			v["history"] = []any{map[string]any{"revision": 999, "reason": "update", "savedAt": "2026-10-28T00:00:00Z", "content": input("x")}}
		},
		func(v map[string]any) { v["history"] = strings.Repeat("x", 100) },
	} {
		s := testStore(t)
		d := mustCreate(t, s, input("first"))
		name := filepath.Join(s.root, "documents", d.ID+".json")
		data, _ := os.ReadFile(name)
		var v map[string]any
		_ = json.Unmarshal(data, &v)
		mutate(v)
		data, _ = json.Marshal(v)
		_ = os.WriteFile(name, data, 0600)
		if _, err := s.Get(d.ID, ""); err == nil {
			t.Fatal("corrupt history accepted")
		}
	}
}

func TestHistoryRejectsReplacedDocumentDirectory(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("first"))
	outside := t.TempDir()
	original := filepath.Join(s.root, "documents")
	if err := os.Rename(original, filepath.Join(outside, "documents")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "documents"), original); err != nil {
		t.Fatal(err)
	}
	if _, err := s.History(d.ID); err == nil {
		t.Fatal("symlink document directory read accepted")
	}
	if _, err := s.Update(d.ID, input("changed"), d.Version); err == nil {
		t.Fatal("symlink document directory write accepted")
	}
}

func TestStoredPublishedAliasSnapshotValidation(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	stored, err := s.loadLocked(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	aliases := map[string]string{"pic.png": "javascript:bad"}
	stored.PublishedAliases = &aliases
	if err = validateStoredRecord(stored); err == nil {
		t.Fatal("draft published aliases accepted")
	}
	published := copyContent(stored.Working)
	stored.Published = &published
	stored.Status = "published"
	stored.PublishedAt = stored.UpdatedAt
	if err = validateStoredRecord(stored); err == nil {
		t.Fatal("unsafe published image alias accepted")
	}
}
