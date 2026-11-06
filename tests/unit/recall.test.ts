import { describe, expect, it } from "vitest";
import { parseRecall, recallNoteContent } from "../../src/lib/recall";

const source = `/articles/${"a".repeat(32)}/#annotation-${"b".repeat(32)}`;
const card = { question: "为什么请求会排队？", answer: "服务槽忙时等待。", source };

describe("bounded recall cards", () => {
  it("accepts plain text and an optional internal citation", () => {
    expect(parseRecall(JSON.stringify(card))).toEqual(card);
    expect(parseRecall('{"question":"问题","answer":"解释"}')).toEqual({
      question: "问题", answer: "解释",
    });
  });

  it.each(["{", "null", "[]", '"card"'])('rejects malformed objects: %s', (raw) => {
    expect(() => parseRecall(raw)).toThrow();
  });

  it.each([
    { script: "alert(1)" }, { question: " " }, { answer: "" },
    { question: null }, { answer: 2 }, { source: null },
    { question: "字".repeat(401) }, { answer: "a".repeat(4001) },
  ])("rejects unsupported fields and invalid text budgets", (patch) => {
    expect(() => parseRecall(JSON.stringify({ ...card, ...patch }))).toThrow();
  });

  it.each([
    "javascript:alert(1)", "https://example.com/", "//example.com/", "/login/",
    "/articles/../login/", `/articles/${"a".repeat(32)}/?next=https://example.com`,
    `/articles/${"a".repeat(32)}/#other`, `/articles/${"a".repeat(32)}/\n`,
  ])("rejects non-citation URLs: %s", (url) => {
    expect(() => parseRecall(JSON.stringify({ ...card, source: url }))).toThrow();
  });

  it("enforces UTF-8 bytes independently from character counts", () => {
    expect(() => parseRecall(JSON.stringify({
      question: "问".repeat(400), answer: "答".repeat(4000),
    }))).toThrow(/12 KiB/);
    expect(parseRecall(JSON.stringify({
      question: "😀".repeat(400), answer: "ok",
    })).question).toHaveLength(800);
  });

  it("keeps HTML literal and safely fences newlines and backticks", () => {
    const annotation = { id: "b".repeat(32), documentId: "a".repeat(32) };
    const note = recallNoteContent(annotation, "问题", "```\n<script>bad()</script>", "2026-10-31");
    expect(note.kind).toBe("note");
    expect(note.related).toEqual([annotation.documentId]);
    expect(note.source.match(/^```/gm)).toHaveLength(2);
    const raw = note.source.split("\n")[1];
    expect(parseRecall(raw).answer).toBe("```\n<script>bad()</script>");
    expect(parseRecall(raw).source).toBe(source);
  });

  it("refuses invalid annotation identifiers", () => {
    expect(() => recallNoteContent({ id: "../bad", documentId: "a".repeat(32) },
      "问题", "答案", "2026-10-31")).toThrow();
  });

  it("keeps multiline questions in the card but normalizes the document title", () => {
    const note = recallNoteContent({ id: "b".repeat(32), documentId: "a".repeat(32) },
      "第一问\n第二问", "解释", "2026-10-31");
    expect(note.title).toBe("问题卡 · 第一问 第二问");
    expect(parseRecall(note.source.split("\n")[1]).question).toBe("第一问\n第二问");
  });
});
