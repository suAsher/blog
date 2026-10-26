package content

import (
	"fmt"
	"strings"
	"testing"
)

func TestOfflineRevisionsOnlyReturnsPublishedCurrentVersions(t *testing.T) {
	s := testStore(t)
	h := NewHandler(s)
	published := publishWiki(t, s, "不得泄露的标题", "正文秘密 [[不存在]]")
	draft := mustCreate(t, s, input("草稿秘密"))
	trash := publishWiki(t, s, "回收站标题", "回收站正文")
	trash, err := s.Action(trash.ID, "trash", trash.Version)
	if err != nil {
		t.Fatal(err)
	}
	missing := strings.Repeat("f", 32)
	ids := strings.Join([]string{published.ID, draft.ID, trash.ID, missing}, ",")
	w := apiCall(h, "GET", "/api/offline-revisions?ids="+ids, nil)
	if w.Code != 200 {
		t.Fatalf("revision endpoint unavailable: %d %s", w.Code, w.Body.String())
	}
	data := metadataResult(t, w)
	revisions := data["revisions"].([]any)
	if len(revisions) != 4 {
		t.Fatal("missing input results", data)
	}
	for i, value := range revisions {
		item := value.(map[string]any)
		if i == 0 {
			if item["available"] != true || item["version"] != float64(published.Version) || len(item) != 3 {
				t.Fatal("published response not minimal", item)
			}
		} else {
			if item["available"] != false || item["version"] != nil || len(item) != 2 {
				t.Fatal("unavailable item leaked metadata", item)
			}
		}
	}
	if strings.Contains(w.Body.String(), "秘密") || strings.Contains(w.Body.String(), "标题") || strings.Contains(w.Body.String(), "source") || strings.Contains(w.Body.String(), "status") {
		t.Fatal("offline revisions leaked article metadata", w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private revisions cacheable")
	}
	changed := input("未发布修改")
	changed.Title = "未发布标题"
	updated, err := s.Update(published.ID, changed, published.Version)
	if err != nil {
		t.Fatal(err)
	}
	data = metadataResult(t, apiCall(h, "GET", "/api/offline-revisions?ids="+published.ID, nil))
	item := data["revisions"].([]any)[0].(map[string]any)
	if item["version"] != float64(updated.Version) || item["available"] != true {
		t.Fatal("revision differs from published detail contract", item)
	}
}

func TestOfflineRevisionsStrictInputBudgetsAndMethods(t *testing.T) {
	h := NewHandler(testStore(t))
	id := strings.Repeat("a", 32)
	tooMany := []string{}
	for i := 0; i < 21; i++ {
		tooMany = append(tooMany, fmt.Sprintf("%032x", i))
	}
	for _, query := range []string{"", "ids=", "ids=bad", "ids=" + id + "," + id, "ids=" + id + ",", "ids=" + strings.Join(tooMany, ","), "ids=" + id + "&unknown=1", "ids=" + id + "&ids=" + id, "ids=%ZZ"} {
		w := apiCall(h, "GET", "/api/offline-revisions?"+query, nil)
		if w.Code != 400 {
			t.Fatalf("bad query accepted %q: %d %s", query, w.Code, w.Body.String())
		}
	}
	if w := apiCall(h, "GET", "/api/offline-revisions?ids="+strings.Repeat("a", 1025), nil); w.Code != 414 {
		t.Fatal("URL budget unbounded", w.Code)
	}
	if w := apiCall(h, "POST", "/api/offline-revisions?ids="+id, nil); w.Code != 405 {
		t.Fatal("revision mutation accepted")
	}
	if w := apiCall(h, "HEAD", "/api/offline-revisions?ids="+id, nil); w.Code != 200 {
		t.Fatal("HEAD unsupported")
	}
	batch := apiCall(h, "GET", "/api/offline-revisions?ids="+strings.Join(tooMany[:20], ","), nil)
	if batch.Code != 200 || len(batch.Body.Bytes()) > 2048 || len(metadataResult(t, batch)["revisions"].([]any)) != 20 {
		t.Fatal("20-ID batch not bounded", batch.Code, batch.Body.String())
	}
}

func TestOfflineRevisionsNeverBuildsLinkIndexOrRendersMarkdown(t *testing.T) {
	s := testStore(t)
	d := publishWiki(t, s, "标题", "[[链接目标]]")
	s.links.invalidate()
	// A deliberately unusable optional index must not affect this metadata API.
	s.links.mu.Lock()
	s.links.limit = 0
	s.links.mu.Unlock()
	w := apiCall(NewHandler(s), "GET", "/api/offline-revisions?ids="+d.ID, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"available":true`) {
		t.Fatal("revision check depends on optional rendering", w.Body.String())
	}
	s.links.mu.Lock()
	built := s.links.value != nil
	s.links.mu.Unlock()
	if built {
		t.Fatal("metadata check built expensive knowledge index")
	}
	for i := 0; i < 20; i++ {
		if w := apiCall(NewHandler(s), "GET", "/api/offline-revisions?ids="+fmt.Sprintf("%032x", i), nil); w.Code != 200 {
			t.Fatal("missing ID should have minimal unavailable response")
		}
	}
}
