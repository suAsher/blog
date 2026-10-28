package content

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

const maxImportReports = 20
const maxImportReportsBytes = 8 << 20

type importReceipt struct {
	RequestID   string `json:"requestId"`
	Fingerprint string `json:"fingerprint"`
	Path        string `json:"path"`
	Action      string `json:"action"`
}
type ImportReportsData struct {
	Reports []importReport `json:"reports"`
}

func newImportID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", bad(503, "暂时无法创建导入记录。")
	}
	return hex.EncodeToString(random), nil
}
func (s *Store) loadImportReportsLocked() (ImportReportsData, error) {
	result := ImportReportsData{Reports: []importReport{}}
	root, err := s.openReadingRoot()
	if err != nil {
		return result, err
	}
	defer root.Close()
	info, err := root.Lstat("import-reports.json")
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > maxImportReportsBytes {
		return result, bad(500, "导入报告文件不安全或超出读取预算。")
	}
	file, err := root.OpenFile("import-reports.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return result, bad(500, "导入报告暂时无法读取。")
	}
	defer file.Close()
	before, err := file.Stat()
	if err != nil || !sameSearchFile(info, before) {
		return result, bad(500, "导入报告读取期间发生变化。")
	}
	data, err := io.ReadAll(io.LimitReader(file, maxImportReportsBytes+1))
	if err != nil || len(data) > maxImportReportsBytes {
		return result, bad(500, "导入报告超出读取预算。")
	}
	after, err := file.Stat()
	if err != nil || !sameSearchFile(before, after) {
		return result, bad(500, "导入报告读取期间发生变化。")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF || len(result.Reports) > maxImportReports {
		return result, bad(500, "导入报告格式异常，请检查备份。")
	}
	seen := map[string]bool{}
	for _, report := range result.Reports {
		if !documentID.MatchString(report.ID) || seen[report.ID] || len(report.Fingerprint) != 64 || len(report.Outcomes) > 500 || len(report.Imported)+len(report.Updated) > 500 || len(report.Skipped) > 500 || len(report.Unresolved) > 20000 {
			return result, bad(500, "导入报告内容异常。")
		}
		if _, err := time.Parse(time.RFC3339Nano, report.CreatedAt); err != nil {
			return result, bad(500, "导入报告时间异常。")
		}
		seen[report.ID] = true
	}
	return result, nil
}
func compactImportReport(report importReport) importReport {
	compact := report
	compact.Imported = append([]Summary{}, report.Imported...)
	compact.Updated = append([]Summary{}, report.Updated...)
	for _, items := range [][]Summary{compact.Imported, compact.Updated} {
		for i := range items {
			items[i] = Summary{ID: items[i].ID, Title: items[i].Title, Status: items[i].Status, Version: items[i].Version}
		}
	}
	return compact
}
func (s *Store) saveImportReport(report importReport) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.loadImportReportsLocked()
	if err != nil {
		return err
	}
	reports := []importReport{compactImportReport(report)}
	for _, previous := range state.Reports {
		if previous.ID != report.ID {
			reports = append(reports, previous)
		}
	}
	var data []byte
	for {
		if len(reports) > maxImportReports {
			reports = reports[:maxImportReports]
		}
		data, err = encodeImportReports(ImportReportsData{reports})
		if err != nil {
			return bad(500, "无法编码导入报告。")
		}
		if len(data) <= maxImportReportsBytes {
			break
		}
		if len(reports) == 1 {
			return bad(413, "本次导入报告超出保留预算，请拆分导入。")
		}
		reports = reports[:len(reports)-1]
	}
	release, err := s.reserveSpace(int64(len(data)))
	if err != nil {
		return err
	}
	defer release()
	root, err := s.openReadingRoot()
	if err != nil {
		return err
	}
	defer root.Close()
	id, err := newImportID()
	if err != nil {
		return err
	}
	name := ".import-report-" + id
	file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return bad(500, "无法创建导入报告。")
	}
	defer root.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return bad(500, "导入报告尚未完整保存，请保留请求标识并重试。")
	}
	if root.Rename(name, "import-reports.json") != nil {
		return bad(500, "导入报告尚未保存，请保留请求标识并重试。")
	}
	directory, err := root.Open(".")
	if err != nil {
		return bad(500, "无法确认导入报告保存状态。")
	}
	defer directory.Close()
	if directory.Sync() != nil {
		return bad(500, "无法确认导入报告保存状态，请按请求标识核对。")
	}
	return nil
}
func (s *Store) ImportReports(id string) (ImportReportsData, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	reports, err := s.loadImportReportsLocked()
	if err != nil {
		return reports, err
	}
	if id == "" {
		return reports, nil
	}
	if !documentID.MatchString(id) {
		return ImportReportsData{}, bad(400, "导入报告标识无效。")
	}
	for _, report := range reports.Reports {
		if report.ID == id {
			return ImportReportsData{[]importReport{report}}, nil
		}
	}
	return ImportReportsData{}, bad(404, "导入报告不存在或已超出保留范围。")
}
func (h *handler) importReports(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		method(w, "GET, HEAD")
		return
	}
	reports, err := h.store.ImportReports(r.URL.Query().Get("id"))
	if err != nil {
		respondError(w, err)
		return
	}
	respond(w, 200, reports)
}

// Private JSON is never embedded in HTML. Disabling HTML escapes prevents
// harmless ampersands in attachment paths from multiplying the storage cost.
func encodeImportReports(reports ImportReportsData) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(reports); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// Bound the final report before committing any document or image. This reserves
// room for either a successful summary or a helpful per-path failure message;
// final persistence may evict older reports but cannot outgrow this envelope.
func preflightImportReport(report importReport, candidates []importCandidate) error {
	worst := compactImportReport(report)
	worst.Skipped = append([]importSkip{}, worst.Skipped...)
	worst.Outcomes = append([]importOutcome{}, worst.Outcomes...)
	for _, candidate := range candidates {
		message := strings.Repeat("错", 400)
		worst.Imported = append(worst.Imported, Summary{ID: strings.Repeat("a", 32), Title: candidate.Title, Status: "published", Version: int(maxSafeRevision)})
		worst.Skipped = append(worst.Skipped, importSkip{candidate.Path, message})
		worst.Outcomes = append(worst.Outcomes, importOutcome{Path: candidate.Path, Status: "invalid", ID: strings.Repeat("a", 32), Version: int(maxSafeRevision), Message: message})
	}
	data, err := encodeImportReports(ImportReportsData{[]importReport{worst}})
	if err != nil {
		return bad(500, "无法检查导入报告大小。")
	}
	if len(data) > maxImportReportsBytes {
		return bad(413, "本次导入报告超出保留预算，请拆分导入后重试。")
	}
	return nil
}
