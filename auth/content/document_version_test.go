package content

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeStoredDocumentVersion(t *testing.T, s *Store, id string, version int64) []byte {
	t.Helper()
	name := filepath.Join(s.root, "documents", id+".json")
	data, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	value["version"] = version
	data, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestStoredDocumentRejectsVersionsAboveJavaScriptSafeInteger(t *testing.T) {
	s := testStore(t)
	d := publishWiki(t, s, "title", "body")
	writeStoredDocumentVersion(t, s, d.ID, maxSafeRevision+1)
	for _, target := range []string{"/api/documents/" + d.ID, "/api/documents?status=published", "/api/offline-revisions?ids=" + d.ID} {
		if w := apiCall(NewHandler(s), "GET", target, nil); w.Code != 500 {
			t.Fatalf("unsafe stored version accepted by %s: %d %s", target, w.Code, w.Body.String())
		}
	}
}

func TestDocumentSafeVersionBoundarySaveAndLastIncrement(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("body"))
	writeStoredDocumentVersion(t, s, d.ID, maxSafeRevision-1)
	updated, err := s.Update(d.ID, input("last allowed edit"), int(maxSafeRevision-1))
	if err != nil || int64(updated.Version) != maxSafeRevision {
		t.Fatal("last safe increment rejected", err)
	}
	s.mu.Lock()
	record, err := s.loadLocked(d.ID)
	if err == nil {
		record.Version = int(maxSafeRevision + 1)
		err = s.saveLocked(record)
	}
	s.mu.Unlock()
	if err == nil {
		t.Fatal("unsafe direct save accepted")
	}
	live, err := s.Get(d.ID, "")
	if err != nil || int64(live.Version) != maxSafeRevision || live.Source != "last allowed edit" {
		t.Fatal("rejected unsafe save damaged valid record", err)
	}
}

func TestDocumentVersionCeilingStopsEveryIncrementWithoutSaving(t *testing.T) {
	for _, scenario := range []struct{ status, action string }{{"draft", "update"}, {"draft", "publish"}, {"draft", "trash"}, {"published", "unpublish"}, {"published", "publish"}, {"published", "trash"}, {"trash", "restore"}} {
		t.Run(scenario.status+"/"+scenario.action, func(t *testing.T) {
			s := testStore(t)
			d := mustCreate(t, s, input("body"))
			var err error
			if scenario.status == "published" {
				d, err = s.Action(d.ID, "publish", d.Version)
			}
			if scenario.status == "trash" {
				d, err = s.Action(d.ID, "trash", d.Version)
			}
			if err != nil {
				t.Fatal(err)
			}
			original := writeStoredDocumentVersion(t, s, d.ID, maxSafeRevision)
			if _, err := s.Get(d.ID, ""); err != nil {
				t.Fatal("highest safe version must remain readable", err)
			}
			if scenario.action == "update" {
				_, err = s.Update(d.ID, input("changed body"), int(maxSafeRevision))
			} else {
				_, err = s.Action(d.ID, scenario.action, int(maxSafeRevision))
			}
			known, ok := err.(*apiError)
			if !ok || known.Status != 503 || known.Code != "DOCUMENT_VERSION_LIMIT" {
				t.Fatalf("version ceiling not explicit: %v", err)
			}
			after, err := os.ReadFile(filepath.Join(s.root, "documents", d.ID+".json"))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(original, after) {
				t.Fatal("version-limit failure changed durable content")
			}
		})
	}
}
