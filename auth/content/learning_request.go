package content

import "reflect"

// Pointer fields distinguish omitted metadata from explicit clearing. The shared
// strict JSON decoder rejects null and unknown fields before this conversion.
func learningValue(input learningRequest, previous LearningPath) LearningPath {
	value := LearningPath{
		Title: input.Title, Description: input.Description, Accent: input.Accent,
		Objectives:    append([]string{}, previous.Objectives...),
		Prerequisites: append([]string{}, previous.Prerequisites...),
		CreationKey:   previous.CreationKey,
	}
	if input.Objectives != nil {
		value.Objectives = append([]string{}, (*input.Objectives)...)
	}
	if input.Prerequisites != nil {
		value.Prerequisites = append([]string{}, (*input.Prerequisites)...)
	}
	if input.CreationKey != nil {
		value.CreationKey = *input.CreationKey
	}
	byID := make(map[string]LearningChapter, len(previous.Chapters))
	for _, chapter := range previous.Chapters {
		byID[chapter.ID] = chapter
	}
	if input.Chapters != nil {
		value.Chapters = make([]LearningChapter, 0, len(input.Chapters))
	}
	for _, chapter := range input.Chapters {
		value.Chapters = append(value.Chapters, learningChapterValue(chapter, byID[chapter.ID]))
	}
	return value
}

func learningChapterValue(input learningChapterRequest, previous LearningChapter) LearningChapter {
	value := LearningChapter{
		ID: input.ID, Title: input.Title, Description: input.Description,
		Goal: previous.Goal, Exercise: previous.Exercise, Practiced: previous.Practiced,
		PracticeDocumentIDs: append([]string{}, previous.PracticeDocumentIDs...),
	}
	if input.DocumentIDs != nil {
		value.DocumentIDs = append([]string{}, input.DocumentIDs...)
	}
	if input.PracticeDocumentIDs != nil {
		value.PracticeDocumentIDs = append([]string{}, (*input.PracticeDocumentIDs)...)
	}
	if input.Goal != nil {
		value.Goal = *input.Goal
	}
	if input.Exercise != nil {
		value.Exercise = *input.Exercise
		if value.Exercise != previous.Exercise {
			value.Practiced = false
		}
	}
	if input.Practiced != nil {
		value.Practiced = *input.Practiced
	}
	return value
}

// Compare only author-supplied content, normalizing absent optional lists. A
// lost POST response can recover its exact route without overwriting edits.
func sameLearningCreation(existing, requested LearningPath) bool {
	normalize := func(value LearningPath) LearningPath {
		value.ID, value.CreatedAt, value.UpdatedAt = "", "", ""
		value.Version = 0
		value.Objectives = append([]string{}, value.Objectives...)
		value.Prerequisites = append([]string{}, value.Prerequisites...)
		chapters := append([]LearningChapter{}, value.Chapters...)
		for index, chapter := range chapters {
			chapters[index].PracticeDocumentIDs = append([]string{}, chapter.PracticeDocumentIDs...)
		}
		value.Chapters = chapters
		return value
	}
	return reflect.DeepEqual(normalize(existing), normalize(requested))
}

func existingLearningCreation(state *learningFile, value LearningPath) (LearningPath, bool, error) {
	if value.CreationKey == "" {
		return LearningPath{}, false, nil
	}
	for _, existing := range state.Paths {
		if existing.CreationKey == value.CreationKey {
			if !sameLearningCreation(existing, value) {
				return LearningPath{}, false, &apiError{
					Status: 409, Code: "CREATION_CONFLICT",
					Message: "这批资料已经创建路线，内容与当前编排不同。请读取已有路线后继续整理。",
				}
			}
			return existing, true, nil
		}
	}
	return LearningPath{}, false, nil
}
