import type { LearningChapter, LearningInput, LearningPath } from "./learning-paths";

/** Reading an article never changes completion of an explicit practice task. */
export function learningPractice(chapters: LearningChapter[]) {
  const exercises = chapters.filter((chapter) => chapter.exercise?.trim());
  const completed = exercises.filter((chapter) => chapter.practiced === true).length;
  return {
    total: exercises.length,
    completed,
    percent: exercises.length ? Math.round(completed / exercises.length * 100) : 0,
    next: exercises.find((chapter) => !chapter.practiced)?.id,
  };
}

export function learningLines(source: string): string[] {
  return source.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function updateLearningChapter(chapter: LearningChapter, patch: Partial<LearningChapter>): LearningChapter {
  const changedExercise = patch.exercise !== undefined && patch.exercise !== (chapter.exercise || "");
  return { ...chapter, ...patch, ...(changedExercise ? { practiced: false } : {}) };
}

export function practiceUpdate(
  path: LearningPath,
  chapterId: string,
  practiced: boolean,
): LearningInput & { version: number } {
  const chapter = path.chapters.find((item) => item.id === chapterId);
  if (!chapter?.exercise?.trim()) throw new Error("这章尚未设置实践任务，请先整理章节。");
  return {
    title: path.title,
    description: path.description,
    accent: path.accent,
    objectives: path.objectives,
    prerequisites: path.prerequisites,
    version: path.version,
    chapters: path.chapters.map((item) => item.id === chapterId ? { ...item, practiced } : { ...item }),
  };
}
