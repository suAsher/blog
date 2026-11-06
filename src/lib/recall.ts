import type { DocumentContent } from "./documents";

export interface RecallCard {
  question: string;
  answer: string;
  source?: string;
}
export const MAX_RECALL_CARDS = 10;
const citation = /^\/articles\/[a-f0-9]{32}\/(?:#annotation-[a-f0-9]{32})?$/;

export function parseRecall(source: string): RecallCard {
  if (new TextEncoder().encode(source).length > 12 * 1024)
    throw new Error("问题卡定义最多 12 KiB，请精简问题和解释。");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("问题卡需要有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("问题卡需要一个对象。");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["question", "answer", "source"].includes(key)))
    throw new Error("问题卡只支持 question、answer 和 source，不执行脚本。");
  for (const [key, limit] of [["question", 400], ["answer", 4000]] as const) {
    const text = object[key];
    if (typeof text !== "string" || !text.trim() || Array.from(text).length > limit)
      throw new Error(`${key === "question" ? "问题" : "解释"}需要 1–${limit} 字。`);
  }
  if (Object.hasOwn(object, "source") &&
      (typeof object.source !== "string" || !citation.test(object.source) || /\s/.test(object.source)))
    throw new Error("来源必须是本站正式文章或批注的地址。");
  return {
    question: object.question as string,
    answer: object.answer as string,
    ...(object.source === undefined ? {} : { source: object.source as string }),
  };
}

export function recallNoteContent(
  annotation: { id: string; documentId: string },
  question: string,
  answer: string,
  date: string,
): DocumentContent {
  if (![annotation.id, annotation.documentId].every((id) => /^[a-f0-9]{32}$/.test(id)))
    throw new Error("批注来源不可用。");
  const card = parseRecall(JSON.stringify({
    question: question.trim(), answer: answer.trim(),
    source: `/articles/${annotation.documentId}/#annotation-${annotation.id}`,
  }));
  return {
    title: Array.from(`问题卡 · ${card.question.replace(/\s+/gu, " ")}`).slice(0, 160).join(""),
    description: "先尝试回答，再展开解释；保留原文出处。",
    date, tags: [], category: "", cover: "", kind: "note",
    related: [annotation.documentId],
    // JSON escapes embedded line breaks, so user text cannot close the fence.
    source: `\`\`\`recall\n${JSON.stringify(card)}\n\`\`\`\n`,
  };
}
