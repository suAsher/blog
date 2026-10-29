package content

import (
	"strings"
	"unicode"
)

const maxLearningBytes = 8 << 20

type LearningChapter struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	DocumentIDs []string `json:"documentIds"`
}
type LearningPath struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Accent      string            `json:"accent"`
	Chapters    []LearningChapter `json:"chapters"`
	Version     int64             `json:"version"`
	CreatedAt   string            `json:"createdAt"`
	UpdatedAt   string            `json:"updatedAt"`
}
type learningRequest struct {
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Accent      string            `json:"accent"`
	Chapters    []LearningChapter `json:"chapters"`
	Version     int64             `json:"version,omitempty"`
}
type learningFile struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Paths         map[string]LearningPath `json:"paths"`
}

func newLearningFile() *learningFile {
	return &learningFile{SchemaVersion: 1, Paths: map[string]LearningPath{}}
}
func learningTitle(title string) bool {
	return researchText(title, 160, true) && strings.IndexFunc(title, unicode.IsControl) < 0
}
func validateLearning(value LearningPath) error {
	if !learningTitle(value.Title) || !researchText(value.Description, 4000, false) || value.Chapters == nil || len(value.Chapters) > 30 || (value.Accent != "mint" && value.Accent != "blue" && value.Accent != "violet") {
		return bad(400, "路线标题、说明、配色或章节无效。")
	}
	chapters := map[string]bool{}
	documents := map[string]bool{}
	for _, chapter := range value.Chapters {
		if !researchQuestionID.MatchString(chapter.ID) || chapters[chapter.ID] || !learningTitle(chapter.Title) || !researchText(chapter.Description, 2000, false) || chapter.DocumentIDs == nil {
			return bad(400, "章节格式无效或重复。")
		}
		chapters[chapter.ID] = true
		for _, id := range chapter.DocumentIDs {
			if !documentID.MatchString(id) || documents[id] {
				return bad(400, "章节文档标识无效或重复。")
			}
			documents[id] = true
			if len(documents) > 300 {
				return bad(413, "每条路线最多包含 300 篇文档。")
			}
		}
	}
	return nil
}
func validateLearningFile(value *learningFile) error {
	if value.SchemaVersion != 1 || value.Paths == nil || len(value.Paths) > 50 {
		return bad(500, "路线状态格式异常，请检查备份。")
	}
	for id, path := range value.Paths {
		if id != path.ID || !documentID.MatchString(id) || !validResearchVersion(path.Version) || !validResearchTimes(path.CreatedAt, path.UpdatedAt) || validateLearning(path) != nil {
			return bad(500, "路线记录异常，请检查备份。")
		}
	}
	return nil
}
