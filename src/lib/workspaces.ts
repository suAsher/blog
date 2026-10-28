import type { DocumentSummary } from "./documents";
export interface WorkspaceQuestion {
  id: string;
  text: string;
  done: boolean;
}
export interface WorkspacePosition {
  id: string;
  x: number;
  y: number;
}
export interface WorkspaceInput {
  title: string;
  description: string;
  documentIds: string[];
  questions: WorkspaceQuestion[];
  positions: WorkspacePosition[];
}
export interface Workspace extends WorkspaceInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export const emptyWorkspace = (): WorkspaceInput => ({
  title: "",
  description: "",
  documentIds: [],
  questions: [],
  positions: [],
});
export function moveDocument(
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
export function removeDocument(
  state: WorkspaceInput,
  id: string,
): WorkspaceInput {
  return {
    ...state,
    documentIds: state.documentIds.filter((value) => value !== id),
    positions: state.positions.filter((value) => value.id !== id),
  };
}
export function boundedPosition(
  id: string,
  x: number,
  y: number,
): WorkspacePosition {
  const bound = (value: number) =>
    Number.isFinite(value) ? Math.max(-100000, Math.min(100000, value)) : 0;
  return { id, x: bound(x), y: bound(y) };
}
export function validateWorkspace(state: WorkspaceInput): string {
  const size = (value: string) => [...value].length;
  if (!state.title.trim() || size(state.title) > 160)
    return "请填写 1–160 字的主题标题。";
  if (size(state.description) > 4000) return "主题说明最多 4000 字。";
  if (
    state.documentIds.length > 100 ||
    new Set(state.documentIds).size !== state.documentIds.length ||
    state.documentIds.some((id) => !/^[a-f0-9]{32}$/.test(id))
  )
    return "文档选择必须唯一，最多 100 篇。";
  if (
    state.questions.length > 50 ||
    new Set(state.questions.map((q) => q.id)).size !== state.questions.length ||
    state.questions.some(
      (q) =>
        !/^[A-Za-z0-9_-]{1,80}$/.test(q.id) ||
        !q.text.trim() ||
        size(q.text) > 1000 ||
        typeof q.done !== "boolean",
    )
  )
    return "问题内容不能为空，每条最多 1000 字，最多 50 条。";
  if (
    state.positions.length > 100 ||
    new Set(state.positions.map((p) => p.id)).size !== state.positions.length ||
    state.positions.some(
      (p) =>
        !state.documentIds.includes(p.id) ||
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        Math.abs(p.x) > 100000 ||
        Math.abs(p.y) > 100000,
    )
  )
    return "画布位置无效，请重新整理节点。";
  return "";
}
export function reapplyWorkspace(
  local: WorkspaceInput,
  latest: Workspace,
): Workspace {
  return {
    ...latest,
    ...local,
    documentIds: [...local.documentIds],
    questions: local.questions.map((q) => ({ ...q })),
    positions: local.positions.map((p) => ({ ...p })),
  };
}
export function resolveWorkspaceDocuments(
  ids: string[],
  documents: DocumentSummary[],
) {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  return ids.map((id) => {
    const document = byId.get(id);
    const availability =
      !document || document.status === "trash"
        ? "unavailable"
        : document.status;
    return { id, document, availability };
  });
}

/** Keep valid choices, giving a newly available second article its own pane. */
export function comparisonSelection(
  ids: string[],
  previous: string[],
): [string, string] {
  const left = ids.includes(previous[0]) ? previous[0] : ids[0] || "";
  const right =
    ids.includes(previous[1]) && previous[1] !== left
      ? previous[1]
      : ids.find((id) => id !== left) || left;
  return [left, right];
}

/** Never describe a working title as the title of its published snapshot. */
export function workspaceDocumentChoices(
  live: DocumentSummary[],
  published: DocumentSummary[],
): DocumentSummary[] {
  const snapshots = new Map(
    published.map((document) => [document.id, document]),
  );
  return live.map((document) => {
    if (document.status !== "published") return { ...document };
    const snapshot = snapshots.get(document.id);
    return {
      ...document,
      title: snapshot?.title || "已发布文档（标题暂不可用）",
    };
  });
}
