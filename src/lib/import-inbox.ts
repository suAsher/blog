import {
  jsonRequest,
  requestJSON,
  type DocumentContent,
  type DocumentDetail,
  type DocumentSummary,
  type ImportReport,
  type Quota,
} from "./documents";

export type ImportAction = "skip" | "create" | "update";
export type ImportCandidate = {
  path: string;
  title: string;
  status: "new" | "duplicate" | "changed" | "invalid";
  existingId?: string;
  version?: number;
  message?: string;
};
export interface ImportPreview {
  candidates: ImportCandidate[];
  skipped: ImportReport["skipped"];
  unresolvedImages: ImportReport["unresolvedImages"];
  warnings: string[];
  quota: Quota;
}
export interface SavedImportReport extends ImportReport {
  id: string;
  createdAt: string;
  updated: DocumentSummary[];
}
export type SelectedImport = { file: File; path: string };
export type ImportDecision = {
  path: string;
  action: ImportAction;
  existingId?: string;
  version?: number;
};
export type RevisionSummary = {
  revision: number;
  title: string;
  savedAt: string;
  reason: string;
};
export interface RevisionDetail extends RevisionSummary {
  content: DocumentContent;
}

export function buildImportDecisions(
  candidates: ImportCandidate[],
  choices: Record<string, ImportAction>,
): ImportDecision[] {
  return candidates.map((candidate) => {
    const action =
      candidate.status === "invalid"
        ? "skip"
        : choices[candidate.path] ||
          (candidate.status === "new" ? "create" : "skip");
    const decision: ImportDecision = { path: candidate.path, action };
    return action === "update"
      ? {
          ...decision,
          existingId: candidate.existingId,
          version: candidate.version,
        }
      : decision;
  });
}

export function importForm(selection: SelectedImport[]): FormData {
  const form = new FormData();
  form.append("paths", JSON.stringify(selection.map((item) => item.path)));
  selection.forEach((item) => form.append("files", item.file, item.file.name));
  return form;
}
export function previewImport(
  selection: SelectedImport[],
): Promise<ImportPreview> {
  return requestJSON("/api/import/preview", {
    method: "POST",
    body: importForm(selection),
  });
}
export function importDocuments(
  selection: SelectedImport[],
  paths: ImportDecision[],
  requestId: string,
): Promise<SavedImportReport> {
  const body = importForm(selection);
  body.append("decisions", JSON.stringify({ requestId, paths }));
  return requestJSON("/api/import", { method: "POST", body });
}
export const listImportReports = () =>
  requestJSON<{ reports: SavedImportReport[] }>("/api/import/reports");
export const listRevisions = (id: string) =>
  requestJSON<{ history: RevisionSummary[] }>(
    `/api/documents/${encodeURIComponent(id)}/history`,
  );
export const getRevision = (id: string, revision: number) =>
  requestJSON<RevisionDetail>(
    `/api/documents/${encodeURIComponent(id)}/history?revision=${revision}`,
  );
export const restoreRevision = (
  id: string,
  version: number,
  revision: number,
) =>
  requestJSON<DocumentDetail>(
    `/api/documents/${encodeURIComponent(id)}/history`,
    jsonRequest("POST", { version, revision }),
  );

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };
export type DiffField = {
  key: string;
  label: string;
  before: string;
  after: string;
};
const metadata = [
  ["title", "标题"],
  ["description", "摘要"],
  ["date", "日期"],
  ["tags", "标签"],
  ["category", "分类"],
  ["cover", "封面"],
  ["kind", "文档类型"],
  ["maturity", "成长状态"],
  ["series", "系列"],
  ["related", "相关文档"],
] as const;
const value = (item: unknown): string =>
  Array.isArray(item) ? item.join("，") : String(item || "");

/** A bounded line comparison: at most 160,000 cells and 400 rendered lines. */
export function compareContent(
  before: DocumentContent,
  after: DocumentContent,
) {
  let metadataTruncated = false;
  const fields = metadata.flatMap(([key, label]) => {
    const left = value(before[key]),
      right = value(after[key]);
    if (left.length > 2000 || right.length > 2000) metadataTruncated = true;
    return left === right
      ? []
      : [
          {
            key,
            label,
            before: left.slice(0, 2000),
            after: right.slice(0, 2000),
          },
        ];
  });
  const left = before.source.split("\n", 10001),
    right = after.source.split("\n", 10001);
  let prefix = 0,
    suffix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const a = left.slice(prefix, left.length - suffix).slice(0, 399);
  const b = right.slice(prefix, right.length - suffix).slice(0, 399);
  const grid = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      grid[i][j] =
        a[i] === b[j]
          ? grid[i + 1][j + 1] + 1
          : Math.max(grid[i + 1][j], grid[i][j + 1]);
  const lines: DiffLine[] = left
    .slice(Math.max(0, prefix - 3), prefix)
    .map((text) => ({ kind: "same", text }));
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i++] });
      j++;
    } else if (
      i < a.length &&
      (j === b.length || grid[i + 1][j] >= grid[i][j + 1])
    ) {
      lines.push({ kind: "removed", text: a[i++] });
    } else lines.push({ kind: "added", text: b[j++] });
  }
  lines.push(
    ...left
      .slice(left.length - suffix, left.length - suffix + Math.min(3, suffix))
      .map((text) => ({ kind: "same" as const, text })),
  );
  const truncated =
    metadataTruncated ||
    left.length > 10000 ||
    right.length > 10000 ||
    left.length - prefix - suffix > 399 ||
    right.length - prefix - suffix > 399 ||
    lines.length > 400 ||
    lines.some((line) => line.text.length > 2000);
  return {
    fields,
    lines: lines
      .slice(0, 400)
      .map((line) => ({ ...line, text: line.text.slice(0, 2000) })),
    truncated,
    sourceChanged: before.source !== after.source,
  };
}
