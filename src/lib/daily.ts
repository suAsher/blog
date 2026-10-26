import { documentHref, type DocumentSummary } from "./documents";
import type { SearchArticle } from "./search";
import type { ReadingState } from "./storage";
export interface Dashboard {
  timezone: string;
  today: string;
  activitySince: string | null;
  historyComplete: boolean;
  activity: { date: string; count: number }[];
  streak: { current: number; longest: number };
  recent: DocumentSummary[];
  drafts: DocumentSummary[];
  review: { random: DocumentSummary | null; onThisDay: DocumentSummary[] };
  stats: { draft: number; published: number; trash: number };
}
export function activityCalendar(
  today: string,
  activity: Dashboard["activity"],
  since: string | null,
  length = 91,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return [];
  const end = Date.parse(`${today}T12:00:00Z`);
  if (!Number.isFinite(end)) return [];
  const counts = new Map(
    activity.map((day) => [
      day.date,
      Math.max(0, Number.isFinite(day.count) ? Math.floor(day.count) : 0),
    ]),
  );
  return Array.from({ length }, (_, index) => {
    const date = new Date(end - (length - index - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      count: counts.get(date) || 0,
      known: Boolean(since && date >= since),
    };
  });
}
export function continuingDocuments<T extends SearchArticle>(
  documents: readonly T[],
  state: ReadingState,
): T[] {
  return documents
    .filter((doc) => state[doc.id]?.progress > 0 && !state[doc.id]?.read)
    .sort((a, b) => state[b.id].updatedAt - state[a.id].updatedAt)
    .slice(0, 3);
}
export function isLatestDashboardRequest(
  requestVersion: number,
  currentVersion: number,
): boolean {
  return requestVersion === currentVersion;
}
export function reviewDocuments<T extends SearchArticle>(
  documents: readonly T[],
): T[] {
  return documents.filter((document) => document.kind !== "note");
}
export function dailyDocumentHref(doc: Pick<DocumentSummary, "id" | "status">) {
  return doc.status === "published"
    ? documentHref(doc.id)
    : `/manage/?id=${encodeURIComponent(doc.id)}`;
}
