package content

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoredRecordInvariantsProtectDetailAndSearch(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unknown lifecycle", func(v map[string]any) { v["status"] = "evergreen" }},
		{"null working", func(v map[string]any) { v["working"] = nil }},
		{"absent working", func(v map[string]any) { delete(v, "working") }},
		{"unknown working kind", func(v map[string]any) { v["working"].(map[string]any)["kind"] = "task" }},
		{"unknown maturity", func(v map[string]any) { v["working"].(map[string]any)["maturity"] = "published" }},
		{"oversize series", func(v map[string]any) { v["working"].(map[string]any)["series"] = strings.Repeat("中", 101) }},
		{"invalid relations", func(v map[string]any) { v["working"].(map[string]any)["related"] = []string{"invalid"} }},
		{"invalid date", func(v map[string]any) { v["working"].(map[string]any)["date"] = "invalid" }},
		{"empty title", func(v map[string]any) { v["working"].(map[string]any)["title"] = "" }},
		{"oversize working source", func(v map[string]any) {
			v["working"].(map[string]any)["source"] = strings.Repeat("a", int(MaxSourceBytes)+1)
		}},
		{"missing published snapshot", func(v map[string]any) { v["published"] = nil }},
		{"unknown published kind", func(v map[string]any) { v["published"].(map[string]any)["kind"] = "task" }},
		{"oversize published source", func(v map[string]any) {
			v["published"].(map[string]any)["source"] = strings.Repeat("a", int(MaxSourceBytes)+1)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			s := testStore(t)
			d := mustCreate(t, s, input("original body"))
			d, err := s.Action(d.ID, "publish", d.Version)
			if err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(s.root, "documents", d.ID+".json")
			data, err := os.ReadFile(name)
			if err != nil {
				t.Fatal(err)
			}
			var value map[string]any
			if err := json.Unmarshal(data, &value); err != nil {
				t.Fatal(err)
			}
			test.mutate(value)
			data, err = json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(name, data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Get(d.ID, ""); err == nil {
				t.Fatal("invalid stored record passed detail validation")
			}
			if _, err := s.List(ListOptions{Status: "published", Limit: 24}); err == nil {
				t.Fatal("invalid stored record entered search cache")
			}
		})
	}
}

func TestLegacyRecordsKeepOptionalMetadataAndActivityCompatible(t *testing.T) {
	s := testStore(t)
	d := mustCreate(t, s, input("old document body"))
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(s.root, "documents", d.ID+".json")
	data, _ := os.ReadFile(name)
	var value map[string]any
	_ = json.Unmarshal(data, &value)
	delete(value, "activity")
	for _, view := range []string{"working", "published"} {
		content := value[view].(map[string]any)
		for _, field := range []string{"kind", "maturity", "series", "related"} {
			delete(content, field)
		}
	}
	data, _ = json.Marshal(value)
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	live, err := s.Get(d.ID, "published")
	if err != nil || live.Kind != "article" || live.HasUnpublishedChanges {
		t.Fatalf("legacy snapshot rejected: %v", err)
	}
	result, err := s.List(ListOptions{Status: "published", Limit: 24})
	if err != nil || result.Total != 1 || result.Documents[0].Kind != "article" {
		t.Fatal("legacy record incompatible with search")
	}
}
