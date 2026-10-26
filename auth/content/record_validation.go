package content

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Disk files are an input boundary too: restoration, corruption, or external
// edits must not bypass the same source and metadata limits as HTTP writes.
// Missing optional fields remain valid for documents written by older versions.
func validateStoredRecord(d *record) error {
	if !documentID.MatchString(d.ID) || d.Version < 1 || int64(d.Version) > maxSafeRevision {
		return bad(400, "文档标识或版本无效。")
	}
	if d.Status != "draft" && d.Status != "published" && d.Status != "trash" {
		return bad(400, "文档生命周期无效。")
	}
	if d.Status == "published" && d.Published == nil {
		return bad(400, "已发布文档缺少发布快照。")
	}
	if d.Status == "draft" && d.Published != nil {
		return bad(400, "草稿不应包含发布快照。")
	}
	for _, history := range [][]string{d.WorkingTitleAliases, d.PublishedTitleAliases} {
		if len(history) > maxTitleAliases || titleAliasBytes(history) > maxTitleAliasBytes {
			return bad(400, "标题历史超出大小限制。")
		}
		seen := map[string]bool{}
		for _, title := range history {
			key := normalized(strings.TrimSpace(title))
			if key == "" || utf8.RuneCountInString(title) > 200 || strings.IndexFunc(title, unicode.IsControl) >= 0 || seen[key] {
				return bad(400, "标题历史格式无效。")
			}
			seen[key] = true
		}
	}
	for _, stamp := range []string{d.CreatedAt, d.UpdatedAt} {
		if _, err := time.Parse(time.RFC3339Nano, stamp); err != nil {
			return bad(400, "文档时间格式无效。")
		}
	}
	if d.Published != nil {
		if _, err := time.Parse(time.RFC3339Nano, d.PublishedAt); err != nil {
			return bad(400, "发布快照时间格式无效。")
		}
		if strings.TrimSpace(d.Published.Source) == "" {
			return bad(400, "发布快照正文无效。")
		}
	} else if d.PublishedAt != "" {
		return bad(400, "文档发布状态不一致。")
	}
	for _, c := range []*Content{&d.Working, d.Published} {
		if c == nil {
			continue
		}
		if c.Kind != "" && c.Kind != "article" && c.Kind != "note" {
			return bad(400, "文档类型无效。")
		}
		if c.Maturity != "" && c.Maturity != "growing" && c.Maturity != "evergreen" {
			return bad(400, "文档成长状态无效。")
		}
		if _, err := time.Parse("2006-01-02", c.Date); err != nil {
			return bad(400, "文档日期格式无效。")
		}
		if _, err := normalizeContent(*c); err != nil {
			return err
		}
		for _, related := range c.Related {
			if related == d.ID {
				return bad(400, "文档不能关联自身。")
			}
		}
	}
	return validateRecordBudget(d)
}

func nextDocumentVersion(current int) (int, error) {
	if current < 1 || int64(current) >= maxSafeRevision {
		return 0, &apiError{Status: 503, Code: "DOCUMENT_VERSION_LIMIT", Message: "文档版本已达安全上限，请先导出备份，再新建文档继续编辑。"}
	}
	return current + 1, nil
}
