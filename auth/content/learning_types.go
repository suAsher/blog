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
	Goal        string   `json:"goal,omitempty"`
	Exercise    string   `json:"exercise,omitempty"`
	Practiced   bool     `json:"practiced,omitempty"`
}
type LearningPath struct {
	ID            string            `json:"id"`
	Title         string            `json:"title"`
	Description   string            `json:"description"`
	Accent        string            `json:"accent"`
	Chapters      []LearningChapter `json:"chapters"`
	Objectives    []string          `json:"objectives,omitempty"`
	Prerequisites []string          `json:"prerequisites,omitempty"`
	CreationKey   string            `json:"creationKey,omitempty"`
	Version       int64             `json:"version"`
	CreatedAt     string            `json:"createdAt"`
	UpdatedAt     string            `json:"updatedAt"`
}
type learningRequest struct {
	Title         string                   `json:"title"`
	Description   string                   `json:"description"`
	Accent        string                   `json:"accent"`
	Chapters      []learningChapterRequest `json:"chapters"`
	Objectives    *[]string                `json:"objectives,omitempty"`
	Prerequisites *[]string                `json:"prerequisites,omitempty"`
	CreationKey   *string                  `json:"creationKey,omitempty"`
	Version       int64                    `json:"version,omitempty"`
}
type learningChapterRequest struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	DocumentIDs []string `json:"documentIds"`
	Goal        *string  `json:"goal,omitempty"`
	Exercise    *string  `json:"exercise,omitempty"`
	Practiced   *bool    `json:"practiced,omitempty"`
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
	if !learningGoals(value.Objectives) || !learningGoals(value.Prerequisites) ||
		(value.CreationKey != "" && !researchQuestionID.MatchString(value.CreationKey)) {
		return bad(400, "路线目标、先修知识或创建标识无效。")
	}
	chapters := map[string]bool{}
	documents := map[string]bool{}
	for _, chapter := range value.Chapters {
		if !researchQuestionID.MatchString(chapter.ID) || chapters[chapter.ID] || !learningTitle(chapter.Title) || !researchText(chapter.Description, 2000, false) || chapter.DocumentIDs == nil {
			return bad(400, "章节格式无效或重复。")
		}
		if !researchText(chapter.Goal, 800, false) || !researchText(chapter.Exercise, 2000, false) {
			return bad(400, "章节目标最多 800 字，实践任务最多 2000 字。")
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
func learningGoals(values []string) bool {
	if len(values) > 8 {
		return false
	}
	for _, value := range values {
		if !researchText(value, 240, true) || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return false
		}
	}
	return true
}
func validateLearningFile(value *learningFile) error {
	if value.SchemaVersion != 1 || value.Paths == nil || len(value.Paths) > 50 {
		return bad(500, "路线状态格式异常，请检查备份。")
	}
	keys := map[string]bool{}
	for id, path := range value.Paths {
		if id != path.ID || !documentID.MatchString(id) || !validResearchVersion(path.Version) || !validResearchTimes(path.CreatedAt, path.UpdatedAt) || validateLearning(path) != nil {
			return bad(500, "路线记录异常，请检查备份。")
		}
		if path.CreationKey != "" {
			if keys[path.CreationKey] {
				return bad(500, "路线创建标识重复，请检查备份。")
			}
			keys[path.CreationKey] = true
		}
	}
	return nil
}
