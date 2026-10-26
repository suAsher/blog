package content

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestKnowledgeEndpointsValidateViewsMethodsAndSnapshotVisibility(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	pub := publishWiki(t, s, "公开快照", "body")
	c := input("draft secret")
	c.Title = "草稿秘密"
	draft := mustCreate(t, s, c)
	for _, path := range []string{"/api/graph", "/api/link-targets", "/api/random", "/api/documents/" + pub.ID + "/links"} {
		w := apiCall(h, "GET", path, nil)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "草稿秘密") {
			t.Fatalf("private snapshot endpoint %s: %s", path, w.Body.String())
		}
		if apiCall(h, "POST", path, map[string]int{"version": pub.Version}).Code != 405 {
			t.Fatal("knowledge endpoint accepts writes", path)
		}
	}
	for _, path := range []string{"/api/graph?view=all", "/api/graph?limit=301", "/api/graph?limit=0", "/api/graph?limit=x", "/api/link-targets?limit=21", "/api/link-targets?view=secret", "/api/link-targets?q=" + strings.Repeat("a", 257), "/api/documents/" + pub.ID + "/links?view=all"} {
		if w := apiCall(h, "GET", path, nil); w.Code != 400 {
			t.Fatalf("invalid arguments accepted %s: %d", path, w.Code)
		}
	}
	if apiCall(h, "GET", "/api/documents/"+draft.ID+"/links", nil).Code != 404 {
		t.Fatal("draft links visible in published view")
	}
	work := metadataResult(t, apiCall(h, "GET", "/api/link-targets?view=working&q=草稿", nil))
	if len(work["documents"].([]any)) != 1 {
		t.Fatal("author completion omitted working draft")
	}
}

func TestGraphResponseCapsDenseEdgesAndBacklinks(t *testing.T) {
	index := &linkIndex{documents: map[string]linkDocument{}, order: []string{}, edges: []GraphEdge{}}
	for i := 0; i < 400; i++ {
		id := fmt.Sprintf("%032x", i+1)
		index.order = append(index.order, id)
		index.documents[id] = linkDocument{node: GraphNode{ID: id, Title: fmt.Sprintf("node%03d", i), Tags: []string{}, Kind: "article"}}
	}
	for i := 0; i < 300; i++ {
		for offset := 1; offset <= 10; offset++ {
			index.edges = append(index.edges, GraphEdge{index.order[i], index.order[(i+offset)%300], "wiki"})
		}
	}
	for i := 300; i < 400; i++ {
		index.edges = append(index.edges, GraphEdge{index.order[i], index.order[0], "related"})
	}
	graph := index.graph(300)
	if len(graph.Edges) > 2400 || graph.TotalEdges != 3100 || !graph.Truncated {
		t.Fatalf("dense graph budget missing: edges=%d total=%d truncated=%t", len(graph.Edges), graph.TotalEdges, graph.Truncated)
	}
	// A smaller viewport keeps its own proportional edge budget.
	graph = index.graph(10)
	if len(graph.Edges) > 80 || !graph.Truncated {
		t.Fatal("small graph response ignores edge budget")
	}
	for i := 1; i < 400; i++ {
		index.edges = append(index.edges, GraphEdge{index.order[i], index.order[0], "wiki"})
	}
	links, err := index.links(index.order[0])
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(links)
	var response map[string]any
	_ = json.Unmarshal(data, &response)
	if len(links.Backlinks) > 300 || response["truncated"] != true {
		t.Fatal("backlink response ignores size budget")
	}
}

func TestKnowledgeIndexBudgetDoesNotFailDurableWrites(t *testing.T) {
	s := testStore(t)
	a := publishWiki(t, s, "目标", "body")
	s.links.mu.Lock()
	s.links.limit = 1
	s.links.value = nil
	s.links.mu.Unlock()
	d, err := s.Create(input("[[目标]]"), "", nil)
	if err != nil || d.Version != 1 || !strings.Contains(d.HTML, "wiki-link--unavailable") {
		t.Fatalf("derived budget broke successful save: %v %s", err, d.HTML)
	}
	if _, err = s.Get(d.ID, ""); err != nil {
		t.Fatal("index budget made article unreadable")
	}
	for _, path := range []string{"/api/graph", "/api/link-targets", "/api/documents/" + a.ID + "/links"} {
		w := apiCall(NewHandler(s), "GET", path, nil)
		var envelope map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &envelope)
		if w.Code != 503 || envelope["code"] != "LINK_INDEX_BUDGET" {
			t.Fatal("index budget not explicit", path, w.Body.String())
		}
	}
	if w := apiCall(NewHandler(s), "GET", "/api/random", nil); w.Code != 200 || !strings.Contains(w.Body.String(), a.ID) {
		t.Fatal("random article unnecessarily depends on optional index")
	}
	s.links.mu.Lock()
	s.links.limit = linkIndexBudget
	s.links.mu.Unlock()
	if w := apiCall(NewHandler(s), "GET", "/api/graph", nil); w.Code != 200 {
		t.Fatal("index did not rebuild after budget restored")
	}
	s.links.mu.Lock()
	if s.links.value.bytes > 4<<20 {
		t.Fatal("retained index exceeds budget")
	}
	s.links.mu.Unlock()
}

func TestGraphIncludesPublishedNotesButRandomOnlySelectsArticles(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	w := apiCall(h, "GET", "/api/random", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"data":null`) {
		t.Fatal("empty random state malformed")
	}
	c := input("note")
	c.Kind = "note"
	d := mustCreate(t, s, c)
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	graph := metadataResult(t, apiCall(h, "GET", "/api/graph", nil))
	if graph["totalNodes"] != float64(1) || graph["nodes"].([]any)[0].(map[string]any)["kind"] != "note" {
		t.Fatal("published note excluded from knowledge graph")
	}
	if w := apiCall(h, "GET", "/api/random", nil); !strings.Contains(w.Body.String(), `"data":null`) {
		t.Fatal("random walkthrough selected note")
	}
	article := publishWiki(t, s, "文章", "body")
	for i := 0; i < 4; i++ {
		w := apiCall(h, "GET", "/api/random", nil)
		if !strings.Contains(w.Body.String(), article.ID) {
			t.Fatal("random article selected draft/note")
		}
	}
}

func TestGraphAndLinksResultsDoNotExposeMutableCache(t *testing.T) {
	s := testStore(t)
	a := publishWiki(t, s, "A", "body")
	b := publishWiki(t, s, "B", "[[A]] [[missing]]")
	s.mu.RLock()
	index, err := s.linksLocked("published")
	s.mu.RUnlock()
	if err != nil {
		t.Fatal(err)
	}
	graph := index.graph(300)
	graph.Nodes[0].Tags[0] = "mutated"
	links, err := index.links(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	links.Unresolved[0].Title = "mutated"
	graph = index.graph(300)
	links, _ = index.links(b.ID)
	if graph.Nodes[0].Tags[0] == "mutated" || links.Unresolved[0].Title == "mutated" {
		t.Fatal("caller mutated immutable knowledge cache")
	}
	back, _ := index.links(a.ID)
	if len(back.Backlinks) != 1 {
		t.Fatal("backlinks missing")
	}
}

func TestGraphRelatedSnapshotAndMutationInvalidation(t *testing.T) {
	s := testStore(t)
	a := publishWiki(t, s, "A", "body")
	b := publishWiki(t, s, "B", "[[A]]")
	c := input("body")
	c.Title = "C"
	c.Related = []string{a.ID}
	d := mustCreate(t, s, c)
	d, err := s.Action(d.ID, "publish", d.Version)
	if err != nil {
		t.Fatal(err)
	}
	h := NewHandler(s)
	graph := metadataResult(t, apiCall(h, "GET", "/api/graph", nil))
	if graph["totalNodes"] != float64(3) || graph["totalEdges"] != float64(2) || len(graph["edges"].([]any)) != 2 {
		t.Fatal("wiki/related graph missing", graph)
	}
	c.Related = []string{b.ID}
	_, err = s.Update(d.ID, c, d.Version)
	if err != nil {
		t.Fatal(err)
	}
	graph = metadataResult(t, apiCall(h, "GET", "/api/graph?limit=1", nil))
	if len(graph["nodes"].([]any)) != 1 || graph["truncated"] != true || graph["totalNodes"] != float64(3) {
		t.Fatal("graph viewport not bounded", graph)
	}
	back := metadataResult(t, apiCall(h, "GET", "/api/documents/"+a.ID+"/links", nil))
	if len(back["backlinks"].([]any)) != 2 {
		t.Fatal("working related edit replaced published relation")
	}
	if _, err = s.Action(b.ID, "unpublish", b.Version); err != nil {
		t.Fatal(err)
	}
	back = metadataResult(t, apiCall(h, "GET", "/api/documents/"+a.ID+"/links", nil))
	if len(back["backlinks"].([]any)) != 1 {
		t.Fatal("withdrawal did not invalidate link index")
	}
}
