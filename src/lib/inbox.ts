import { jsonRequest, requestJSON, type DocumentSummary } from "./documents";

export type InboxStage = "pending" | "organized" | "verified";
export type InboxViewName =
  "pending" | "unassigned" | "unverified" | "verified" | "all";
export interface InboxFilter {
  view: InboxViewName;
  q: string;
  tag: string;
  routeId: string;
}
export interface InboxView {
  id: string;
  name: string;
  filter: InboxFilter;
}
export interface InboxRoute {
  id: string;
  title: string;
}
export interface InboxDocument extends DocumentSummary {
  stage: InboxStage;
  routes: InboxRoute[];
}
export interface InboxData {
  version: number;
  documents: InboxDocument[];
  total: number;
  counts: Record<InboxViewName, number>;
  tags: { name: string; count: number }[];
  routes: InboxRoute[];
  views: InboxView[];
}

export const inboxViews: Record<InboxViewName, string> = {
  pending: "待整理",
  unassigned: "未归路线",
  unverified: "待验证",
  verified: "已验证",
  all: "全部资料",
};
export const inboxStages: Record<InboxStage, string> = {
  pending: "待整理",
  organized: "待验证",
  verified: "已验证",
};
const documentID = /^[a-f0-9]{32}$/;
const bounded = (value: string, limit: number) =>
  [...value].slice(0, limit).join("");

export function readInboxFilter(params: URLSearchParams): InboxFilter {
  const view = params.get("view") || "pending";
  const routeId = params.get("routeId") || "";
  return {
    view: Object.hasOwn(inboxViews, view) ? (view as InboxViewName) : "pending",
    q: bounded(params.get("q") || "", 256),
    tag: bounded(params.get("tag") || "", 80),
    routeId: documentID.test(routeId) ? routeId : "",
  };
}

export function inboxQuery(filter: InboxFilter, offset = 0): string {
  return new URLSearchParams({
    ...filter,
    offset: String(offset),
    limit: "50",
  }).toString();
}

export function readInboxOffset(params: URLSearchParams): number {
  const offset = Number(params.get("offset") || 0);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 10000
    ? Math.floor(offset / 50) * 50
    : 0;
}

export function selectInboxIds(
  current: string[],
  ids: string[],
  checked: boolean,
): string[] {
  if (!checked) return current.filter((id) => !ids.includes(id));
  return [...new Set([...current, ...ids])]
    .filter((id) => documentID.test(id))
    .slice(0, 100);
}

export function validateInboxView(view: InboxView): string {
  const safe = (value: string, limit: number) =>
    [...value].length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
  if (
    !/^[A-Za-z0-9_-]{1,80}$/.test(view.id) ||
    !view.name.trim() ||
    !safe(view.name, 60)
  )
    return "视图名称请填写 1 至 60 个字。";
  const filter = view.filter;
  if (
    !Object.hasOwn(inboxViews, filter.view) ||
    !safe(filter.q, 256) ||
    !safe(filter.tag, 80) ||
    (filter.routeId !== "" && !documentID.test(filter.routeId))
  )
    return "筛选内容无效或超过长度限制。";
  return "";
}

export const loadInbox = (
  filter: InboxFilter,
  offset = 0,
  signal?: AbortSignal,
) =>
  requestJSON<InboxData>(`/api/inbox?${inboxQuery(filter, offset)}`, {
    signal,
  });

export const updateInboxStage = (
  version: number,
  documentIds: string[],
  stage: InboxStage,
) =>
  requestJSON<{ version: number }>(
    "/api/inbox/batch",
    jsonRequest("PUT", { version, documentIds, stage }),
  );

export const saveInboxViews = (version: number, views: InboxView[]) =>
  requestJSON<{ version: number }>(
    "/api/inbox/views",
    jsonRequest("PUT", { version, views }),
  );
