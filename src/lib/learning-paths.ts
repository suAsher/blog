import type { ReadingState } from "./storage";

export interface LearningChapter {
  id: string;
  title: string;
  description: string;
  documentIds: string[];
}
export interface LearningInput {
  title: string;
  description: string;
  accent: "mint" | "blue" | "violet";
  chapters: LearningChapter[];
}
export interface LearningPath extends LearningInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export function learningProgress(
  chapters: LearningChapter[],
  published: Set<string>,
  state: ReadingState,
) {
  const ids = [
    ...new Set(chapters.flatMap((chapter) => chapter.documentIds)),
  ].filter((id) => published.has(id));
  const completed = ids.filter((id) => state[id]?.read).length;
  return {
    total: ids.length,
    completed,
    percent: ids.length ? Math.round((completed / ids.length) * 100) : 0,
    next: ids.find((id) => !state[id]?.read),
  };
}
export function moveLesson(
  ids: string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const index = ids.indexOf(id),
    next = index + direction;
  if (index < 0 || next < 0 || next >= ids.length) return [...ids];
  const result = [...ids];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}
export function validateLearningPath(value: LearningInput): string {
  if (!value.title.trim() || [...value.title].length > 160)
    return "方向名称需要 1–160 字。";
  if ([...value.description].length > 4000) return "方向说明最多 4000 字。";
  if (!["mint", "blue", "violet"].includes(value.accent))
    return "请选择有效的主题色。";
  if (value.chapters.length > 30) return "一条路线最多 30 章。";
  const ids = value.chapters.flatMap((chapter) => chapter.documentIds);
  if (
    ids.length > 300 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-f0-9]{32}$/.test(id))
  )
    return "文章不能重复加入，一条路线最多 300 篇。";
  if (
    new Set(value.chapters.map((chapter) => chapter.id)).size !==
      value.chapters.length ||
    value.chapters.some(
      (chapter) =>
        !/^[A-Za-z0-9_-]{1,80}$/.test(chapter.id) ||
        !chapter.title.trim() ||
        [...chapter.title].length > 160 ||
        [...chapter.description].length > 2000,
    )
  )
    return "请填写每章标题，章节导读最多 2000 字。";
  return "";
}
