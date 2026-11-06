import { validateLearningPath, type LearningInput } from "./learning-paths";

export interface ImportRouteDocument {
  id: string;
  title: string;
  status: string;
}
export interface RouteImportReport {
  id: string;
  imported: ImportRouteDocument[];
  updated?: ImportRouteDocument[];
  outcomes?: { path: string; status: string; id?: string }[];
  unresolvedImages: { document: string; path: string }[];
}
export interface ImportRouteDraft {
  reportId: string;
  title: string;
  description: string;
  chapters: { id: string; title: string }[];
  lessons: { id: string; title: string; path: string; chapterId: string }[];
  excluded: number;
}
const idPattern = /^[a-f0-9]{32}$/;
const natural = new Intl.Collator("zh-CN", { numeric: true });

function safePath(path: string): boolean {
  return path.length <= 2048 && !/[\\\x00-\x1f\x7f]/.test(path) &&
    !path.split("/").some(part => !part || part === "." || part === "..") &&
    /\.(md|markdown|txt)$/i.test(path);
}

/** Only successful receipt outcomes with current, available documents can be arranged. */
export function importRouteCandidates(report: RouteImportReport) {
  const affected = new Set([...report.imported, ...(report.updated || [])].map(item => item.id));
  const unresolved = new Set(report.unresolvedImages.map(item => item.document));
  const seen = new Set<string>();
  return (report.outcomes || []).filter(item => {
    if (!item.id || !idPattern.test(item.id) || !affected.has(item.id) ||
      !["create", "update"].includes(item.status) || !safePath(item.path) ||
      unresolved.has(item.path) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function proposeImportRoute(
  report: RouteImportReport,
  documents: ImportRouteDocument[],
): ImportRouteDraft {
  if (!idPattern.test(report.id)) throw new Error("导入报告标识无效，请重新读取报告。");
  const available = new Map(documents.filter(doc =>
    doc.status === "draft" || doc.status === "published").map(doc => [doc.id, doc]));
  const outcomes = importRouteCandidates(report)
    .filter(item => available.has(item.id!))
    .sort((a, b) => natural.compare(a.path, b.path));
  if (outcomes.length > 300) throw new Error("本批可编排文档超过 300 篇，请在路线页分批整理。");
  const roots = outcomes.map(item => item.path.split("/"));
  const commonRoot = roots.length > 0 && roots.every(parts => parts.length > 1 && parts[0] === roots[0][0])
    ? roots[0][0] : "";
  const directory = (path: string) => {
    const parts = path.split("/").slice(commonRoot ? 1 : 0, -1);
    return parts.join(" / ") || "起步与资料";
  };
  const directories = [...new Set(outcomes.map(item => directory(item.path)))];
  const chapters = directories.map((title, index) => ({
    id: `import-${report.id}-${index + 1}`, title,
  }));
  return {
    reportId: report.id,
    title: (commonRoot || "导入资料学习路线").slice(0, 160),
    description: "",
    chapters,
    lessons: outcomes.map(item => ({
      id: item.id!, path: item.path, title: available.get(item.id!)!.title,
      chapterId: chapters[directories.indexOf(directory(item.path))].id,
    })),
    excluded: (report.outcomes || []).length - outcomes.length,
  };
}

export function assignImportLesson(draft: ImportRouteDraft, id: string, chapterId: string): ImportRouteDraft {
  if (chapterId && !draft.chapters.some(chapter => chapter.id === chapterId)) return draft;
  return { ...draft, lessons: draft.lessons.map(lesson =>
    lesson.id === id ? { ...lesson, chapterId } : lesson) };
}

export function moveImportItem<T>(items: T[], value: T, direction: -1 | 1): T[] {
  const index = items.indexOf(value), target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function routeInput(draft: ImportRouteDraft): LearningInput & { creationKey: string } {
  const chapters = draft.chapters.map(chapter => ({
    ...chapter, title: chapter.title.trim(), description: "",
    documentIds: draft.lessons.filter(item => item.chapterId === chapter.id).map(item => item.id),
  })).filter(chapter => chapter.documentIds.length > 0);
  const value = {
    title: draft.title.trim(), description: draft.description.trim(),
    accent: "blue" as const, chapters, creationKey: `import-${draft.reportId}`,
  };
  if (!chapters.length) throw new Error("请至少安排一篇文档，空章不会写入路线。");
  const invalid = validateLearningPath(value);
  if (invalid) throw new Error(invalid);
  return value;
}
