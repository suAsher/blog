import {
  jsonRequest,
  requestJSON,
  type DocumentContent,
  type DocumentDetail,
} from "./documents";
export const QUICK_NOTE_KEY = "asher-quick-note-shortcut-v1";
export const QUICK_NOTE_DRAFT_KEY = "asher-quick-note-draft-v1";
export const TODAY_NOTE_DRAFT_KEY = "asher-today-note-draft-v1";
export type QuickNoteShortcut = "alt-n" | "shift-u" | "off";
export function quickNoteShortcut(raw: string | null): QuickNoteShortcut {
  return raw === "shift-u" || raw === "off" ? raw : "alt-n";
}
export function retainedDraftAfterSave(
  current: string,
  submitted: string,
): string {
  return current === submitted ? "" : current;
}
type KeyEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
>;
export function matchesQuickNoteShortcut(
  event: KeyEvent,
  shortcut: QuickNoteShortcut,
): boolean {
  if (
    event.isComposing ||
    !(event.ctrlKey || event.metaKey) ||
    shortcut === "off"
  )
    return false;
  return shortcut === "alt-n"
    ? event.key.toLowerCase() === "n" && event.altKey && !event.shiftKey
    : event.key.toLowerCase() === "u" && event.shiftKey && !event.altKey;
}
export function quickNoteContent(
  source: string,
  date: string,
): DocumentContent {
  const first = source.split(/\r?\n/).find((line) => line.trim());
  if (!first) throw new Error("先写下一点想法，再保存为随手记。");
  const title =
    Array.from(first.trim().replace(/^#{1,6}\s+/, ""))
      .slice(0, 200)
      .join("") || "随手记";
  return {
    title,
    source,
    date,
    kind: "note",
    description: "",
    tags: [],
    category: "",
    cover: "",
  };
}
export function shanghaiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function saveQuickNote(source: string): Promise<DocumentDetail> {
  return requestJSON<DocumentDetail>(
    "/api/documents",
    jsonRequest("POST", quickNoteContent(source, shanghaiToday())),
  );
}
