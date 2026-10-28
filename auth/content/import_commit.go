package content

import (
	"net/http"
	"strings"
	"time"
)

func (s *Store) importHTTP(w http.ResponseWriter, r *http.Request) {
	if !beginUpload(w) {
		return
	}
	defer endUpload()
	files, _, cleanup, err := s.stageUpload(w, r)
	if err != nil {
		respondError(w, err)
		return
	}
	defer cleanup()
	if len(files) == 0 {
		respondError(w, bad(400, "请选择要导入的文档。"))
		return
	}
	fingerprint, err := importFingerprint(files)
	if err != nil {
		respondError(w, bad(500, "无法校验导入内容。"))
		return
	}
	options := files[0].Decisions
	id := ""
	if options != nil {
		id = options.RequestID
	}
	if id == "" {
		id, err = newImportID()
		if err != nil {
			respondError(w, err)
			return
		}
	}
	reports, err := s.ImportReports("")
	if err != nil {
		respondError(w, err)
		return
	}
	for _, report := range reports.Reports {
		if report.ID == id {
			if report.Fingerprint != fingerprint {
				respondError(w, bad(409, "此导入请求标识已用于不同内容，请重新预览并创建新请求。"))
				return
			}
			respond(w, 200, report)
			return
		}
	}
	prepared, err := s.prepareImport(files)
	if err != nil {
		respondError(w, err)
		return
	}
	report := importReport{ID: id, CreatedAt: s.now().UTC().Format(time.RFC3339Nano), Fingerprint: fingerprint, Imported: []Summary{}, Updated: []Summary{}, Outcomes: []importOutcome{}, Skipped: prepared.preview.Skipped, Unresolved: prepared.preview.Unresolved, Warnings: prepared.preview.Warnings}
	if err := preflightImportReport(report, prepared.preview.Candidates); err != nil {
		respondError(w, err)
		return
	}
	recoveredDocuments, err := s.importReceiptDocuments(id, fingerprint)
	if err != nil {
		respondError(w, err)
		return
	}
	decisions := map[string]importDecision{}
	if options != nil {
		for _, decision := range options.Paths {
			decisions[decision.Path] = decision
		}
	}
	for _, candidate := range prepared.preview.Candidates {
		decision, explicit := decisions[candidate.Path]
		if !explicit {
			decision = importDecision{Path: candidate.Path, Action: "create"}
			if options != nil && (candidate.Status == "duplicate" || candidate.Status == "changed") {
				decision.Action = "skip"
			}
		}
		if candidate.Status == "invalid" {
			report.Skipped = append(report.Skipped, importSkip{candidate.Path, candidate.Message})
			report.Outcomes = append(report.Outcomes, importOutcome{Path: candidate.Path, Status: "invalid", Message: candidate.Message})
			continue
		}
		if decision.Action == "skip" {
			message := "已按导入决策跳过。"
			if !explicit {
				message = "已跳过已有文档，请显式选择新建副本或更新。"
			}
			report.Skipped = append(report.Skipped, importSkip{candidate.Path, message})
			report.Outcomes = append(report.Outcomes, importOutcome{Path: candidate.Path, Status: "skipped", Message: message})
			continue
		}
		receipt := &importReceipt{id, fingerprint, candidate.Path, decision.Action}
		recovered, found := recoveredDocuments[candidate.Path]
		var document Detail
		if found {
			document = recovered
		} else {
			aliases := prepared.aliases[candidate.Path]
			assetFailed := false
			for _, url := range aliases {
				if file, ok := prepared.assets[url]; ok {
					if _, err = s.saveAsset(file.Temp, file.Path); err != nil {
						assetFailed = true
						break
					}
				}
			}
			if assetFailed {
				report.Skipped = append(report.Skipped, importSkip{candidate.Path, err.Error()})
				report.Outcomes = append(report.Outcomes, importOutcome{Path: candidate.Path, Status: "failed", Message: err.Error()})
				continue
			}
			content := prepared.documents[candidate.Path]
			if decision.Action == "update" {
				document, err = s.importUpdate(decision.ExistingID, content, decision.Version, candidate.Path, aliases, receipt)
			} else {
				document, err = s.createImported(content, candidate.Path, aliases, receipt)
			}
			if err != nil {
				report.Skipped = append(report.Skipped, importSkip{candidate.Path, err.Error()})
				report.Outcomes = append(report.Outcomes, importOutcome{Path: candidate.Path, Status: "failed", Message: err.Error()})
				continue
			}
		}
		if decision.Action == "update" {
			report.Updated = append(report.Updated, document.Summary)
		} else {
			report.Imported = append(report.Imported, document.Summary)
		}
		report.Outcomes = append(report.Outcomes, importOutcome{Path: candidate.Path, Status: decision.Action, ID: document.ID, Version: document.Version})
	}
	report.Quota = s.quota()
	if err = s.saveImportReport(report); err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, report)
}
func (s *Store) importReceiptDocuments(id, fingerprint string) (map[string]Detail, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := map[string]Detail{}
	conflict := false
	var detailErr error
	err := s.visitImportRecordsLocked(func(d *record) {
		if d.ImportReceipt == nil || d.ImportReceipt.RequestID != id {
			return
		}
		if d.ImportReceipt.Fingerprint != fingerprint {
			conflict = true
			return
		}
		document, err := s.detail(d, "")
		if err != nil {
			detailErr = err
			return
		}
		result[d.ImportReceipt.Path] = document
	})
	if err != nil {
		return nil, err
	}
	if detailErr != nil {
		return nil, detailErr
	}
	if conflict {
		return nil, bad(409, "此请求标识已用于不同内容，请创建新导入请求。")
	}
	return result, nil
}
func (s *Store) importUpdate(id string, c Content, version int, sourcePath string, aliases map[string]string, receipt *importReceipt) (Detail, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, err := s.loadLocked(id)
	if err != nil {
		return Detail{}, err
	}
	if d.Version != version {
		return Detail{}, bad(409, "文档已在预览后更新，请重新预览再导入。")
	}
	if d.Status == "trash" {
		return Detail{}, bad(409, "请先从垃圾箱恢复文档。")
	}
	c, err = normalizeContent(c)
	if err != nil {
		return Detail{}, err
	}
	for _, target := range c.Related {
		if target == id {
			return Detail{}, bad(400, "文档不能关联自身。")
		}
	}
	if !sameContent(c, d.Working) || !sameAliases(aliases, d.Aliases) {
		next, err := nextDocumentVersion(d.Version)
		if err != nil {
			return Detail{}, err
		}
		rememberHistory(d, "import")
		if d.Working.Title != c.Title {
			d.WorkingTitleAliases = rememberTitle(d.WorkingTitleAliases, d.Working.Title)
		}
		if d.Working.Source != c.Source && strings.TrimSpace(c.Source) != "" {
			d.Activity = addActivity(d.Activity, s.now())
		}
		d.Working = c
		d.Version = next
		d.UpdatedAt = s.now().UTC().Format(time.RFC3339Nano)
	}
	preservePublishedAliases(d)
	d.Aliases = copyAliases(aliases)
	d.SourcePath = sourcePath
	d.ImportReceipt = receipt
	if err = s.saveLocked(d); err != nil {
		return Detail{}, err
	}
	return s.detail(d, "")
}
