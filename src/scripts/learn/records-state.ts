import type { DocumentSummary } from "../../lib/documents";
import type { LearningChapter, LearningPath } from "../../lib/learning-paths";

export interface PracticeRecovery {
  documentId: string;
  document?: DocumentSummary;
  action: "attach" | "remove";
  created: boolean;
}
export interface PracticeRecordsContext {
  path: LearningPath;
  chapter: LearningChapter;
  documents: DocumentSummary[];
  onSaved: (path: LearningPath, document?: DocumentSummary) => void;
}
let recovery = new Map<string, PracticeRecovery>();
let uncertain = new Set<string>();
export const recordsKey = (context: PracticeRecordsContext) =>
  `${context.path.id}:${context.chapter.id}`;
export const recordRecovery = (key: string) => recovery.get(key);
export const recordUncertain = (key: string) => uncertain.has(key);
export function setRecordRecovery(key: string, value?: PracticeRecovery) {
  recovery = new Map([...recovery].filter(([item]) => item !== key));
  if (value) recovery = new Map([...recovery, [key, value]]);
}
export function markRecordUncertain(key: string) {
  uncertain = new Set([...uncertain, key]);
}
