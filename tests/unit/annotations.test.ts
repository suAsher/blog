import { describe, expect, it } from "vitest";
import {
  annotationNoteContent,
  createQuoteResolver,
  createQuoteSelector,
  normalizeQuoteText,
  resolveQuote,
} from "../../src/lib/annotations";

describe("annotation quote anchors", () => {
  it("normalizes whitespace while mapping the source range correctly", () => {
    const source = "前言\n\nHello  \tworld\n结束";
    const quote = createQuoteSelector(
      source,
      source.indexOf("Hello"),
      source.indexOf("\n结束"),
    );
    expect(quote?.exact).toBe("Hello world");
    expect(resolveQuote(source, quote!)).toEqual({
      state: "matched",
      start: source.indexOf("Hello"),
      end: source.indexOf("\n结束"),
    });
    expect(normalizeQuoteText("  中文\n\t段落  ")).toBe("中文 段落");
  });
  it("uses surrounding text to disambiguate repeated Chinese excerpts", () => {
    const source = "第一处：相同的句子。第二处：相同的句子。";
    const start = source.lastIndexOf("相同的句子");
    const quote = createQuoteSelector(source, start, start + 5)!;
    expect(resolveQuote(source, quote)).toEqual({
      state: "matched",
      start,
      end: start + 5,
    });
    expect(
      resolveQuote("相同的句子。相同的句子。", {
        exact: "相同的句子",
        prefix: "",
        suffix: "",
      }).state,
    ).toBe("ambiguous");
  });
  it("does not bind a changed or newly ambiguous excerpt to the wrong occurrence", () => {
    const quote = createQuoteSelector("原上下文 引文 后文", 5, 7)!;
    expect(resolveQuote("全新上下文 引文 后文", quote).state).toBe("stale");
    expect(
      resolveQuote("原上下文 引文 后文 原上下文 引文 后文", quote).state,
    ).toBe("ambiguous");
    expect(resolveQuote("原上下文 已经改写 后文", quote).state).toBe("missing");
  });
  it("handles Unicode context and refuses blank, out of bounds or excessive selections", () => {
    expect(createQuoteSelector("abc", -1, 2)).toBeNull();
    expect(createQuoteSelector("abc", 0, 4)).toBeNull();
    expect(createQuoteSelector(" a ", 0, 1)).toBeNull();
    expect(createQuoteSelector("🌱".repeat(2001), 0, 4002)).toBeNull();
    expect(createQuoteSelector("🌱".repeat(2000), 0, 4000)?.exact).toBe(
      "🌱".repeat(2000),
    );
    const quote = createQuoteSelector("🌱".repeat(200) + "句子", 400, 402)!;
    expect(Array.from(quote.prefix)).toHaveLength(128);
    expect(resolveQuote("🌱".repeat(200) + "句子", quote).state).toBe(
      "matched",
    );
  });
  it("ignores document edge whitespace and refuses incomplete surrogate selections", () => {
    const source = "  前文  引文  后文  ";
    const quote = createQuoteSelector(
      source,
      source.indexOf("引文"),
      source.indexOf("引文") + 2,
    )!;
    expect(resolveQuote(source, quote).state).toBe("matched");
    const first = createQuoteSelector("  引文 后文", 0, 4)!;
    expect(resolveQuote("\n引文 后文", first).state).toBe("matched");
    const last = createQuoteSelector("前文 引文  ", 3, 7)!;
    expect(resolveQuote("前文 引文\n", last).state).toBe("matched");
    expect(createQuoteSelector("🌱", 0, 1)).toBeNull();
    expect(createQuoteSelector("🌱", 1, 2)).toBeNull();
  });
  it("allows whitespace-only changes without losing the anchor", () => {
    const quote = createQuoteSelector("前文 引文 后文", 3, 5)!;
    expect(resolveQuote("前文\n 引文\t后文", quote)).toEqual({
      state: "matched",
      start: 4,
      end: 6,
    });
  });
});

describe("annotation to note", () => {
  it("creates a new note with an excerpt, thought and valid article deep link", () => {
    const note = annotationNoteContent(
      {
        documentId: "a".repeat(32),
        id: "b".repeat(32),
        quote: { exact: "<img src=x> [link]", prefix: "", suffix: "" },
        body: "<script>bad</script>",
      },
      "Source [title]",
      "2026-10-28",
    );
    expect(note.kind).toBe("note");
    expect(note.source).toContain(
      `/articles/${"a".repeat(32)}/#annotation-${"b".repeat(32)}`,
    );
    expect(note.source).toContain("&lt;img");
    expect(note.source).not.toContain("<script>");
    expect(note.source).toContain("bad");
    expect(() =>
      annotationNoteContent(
        {
          documentId: "javascript:alert(1)",
          id: "b".repeat(32),
          quote: { exact: "x", prefix: "", suffix: "" },
          body: "",
        },
        "x",
        "2026-10-28",
      ),
    ).toThrow();
  });
});

it("shares one quote index across 200 unique excerpts in a two MiB article", () => {
  const paragraph = "Reading context with spaces and unicode 🌱. ".repeat(65);
  const parts = Array.from(
    { length: 760 },
    (_, index) => `${paragraph} unique-marker-${index} end.\n`,
  );
  const source = parts.join("");
  expect(source.length).toBeGreaterThan(2_000_000);
  const started = performance.now();
  const resolve = createQuoteResolver(source);
  for (let index = 0; index < 200; index++) {
    const exact = `unique-marker-${index} end.`;
    const found = resolve({ exact, prefix: "", suffix: "" });
    expect(found).toEqual({
      state: "matched",
      start: source.indexOf(exact),
      end: source.indexOf(exact) + exact.length,
    });
  }
  expect(performance.now() - started).toBeLessThan(2500);
}, 5000);

it("preserves context uniqueness and Unicode boundaries in a shared resolver", () => {
  const source = "  🌱 first  quote here. second quote there.  ";
  const resolve = createQuoteResolver(source);
  const start = source.indexOf("quote");
  const quote = createQuoteSelector(source, start, start + 5)!;
  expect(resolve(quote)).toEqual({ state: "matched", start, end: start + 5 });
  expect(resolve({ exact: "quote", prefix: "", suffix: "" }).state).toBe(
    "ambiguous",
  );
  expect(
    resolve({ exact: "first", prefix: "changed ", suffix: "" }).state,
  ).toBe("stale");
  expect(resolve({ exact: "absent", prefix: "", suffix: "" }).state).toBe(
    "missing",
  );
  const emoji = source.indexOf("🌱");
  expect(resolve({ exact: "🌱", prefix: "", suffix: "" })).toEqual({
    state: "matched",
    start: emoji,
    end: emoji + 2,
  });
});
