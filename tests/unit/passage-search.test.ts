import { describe, expect, it } from "vitest";
import { articleSibling } from "../../src/scripts/editorial-reader";
import {
  parsePassageQuery,
  passageParams,
  passageHref,
  highlightSegments,
  passageTargetState,
  passageRecoveryHref,
  type Passage,
} from "../../src/lib/passage-search";

const id = "a".repeat(32);
const revision = "b".repeat(64);
const anchor = `passage-${"c".repeat(20)}-1`;
const passage = {
  documentId: id,
  revision,
  anchor,
  paths: [],
} as unknown as Passage;

describe("bounded passage search URLs", () => {
  it("starts empty and restores a shareable filtered page", () => {
    expect(parsePassageQuery("").state).toEqual({
      q: "",
      tag: "",
      pathId: "",
      limit: 12,
      offset: 0,
    });
    const query = parsePassageQuery(
      `?q=缓存+cache&tag=Go&pathId=${id}&limit=20&offset=40`,
    );
    expect(query.error).toBeUndefined();
    expect(parsePassageQuery(`?${passageParams(query.state)}`).state).toEqual(
      query.state,
    );
  });
  it("rejects ambiguous, unknown, unbounded and malformed parameters without truncating intent", () => {
    for (const query of [
      "?q=a&q=b",
      "?q=a&unknown=1",
      "?q=a&limit=0",
      "?q=a&limit=41",
      "?q=a&offset=-1",
      "?q=a&offset=2001",
      "?q=a&offset=1.5",
      "?q=a&pathId=bad",
      "?q=a%00b",
      "?q=a%09b",
      "?q=a&tag=bad%0Atag",
      `?q=a&tag=${"文".repeat(65)}`,
      `?q=${"词".repeat(257)}`,
      `?q=${Array.from({ length: 17 }, (_, i) => `word${i}`).join("+")}`,
      `?q=a&tag=${"a".repeat(4100)}`,
    ]) {
      expect(parsePassageQuery(query).error, query).toBeTruthy();
    }
  });
  it("accepts unicode code points and trims surrounding whitespace", () => {
    expect(parsePassageQuery(`?q=${"🙂".repeat(256)}`).error).toBeUndefined();
    expect(parsePassageQuery("?q=++cache++").state.q).toBe("cache");
    expect(parsePassageQuery("?q=+++").state.q).toBe("");
  });
  it("links to the precise publication and only a verified selected route", () => {
    const result = {
      ...passage,
      paths: [
        {
          pathId: id,
          pathTitle: "route",
          chapterId: "one",
          chapterTitle: "chapter",
        },
      ],
    };
    expect(passageHref(result, "缓存 & C++", id)).toBe(
      `/articles/${id}/?passageRevision=${revision}&q=%E7%BC%93%E5%AD%98+%26+C%2B%2B&path=${id}#${anchor}`,
    );
    expect(passageHref(passage, "cache", id)).not.toContain("&path=");
    expect(
      passageHref({ ...passage, documentId: "javascript:alert(1)" }, "x"),
    ).toBeNull();
    expect(
      passageHref({ ...passage, anchor: 'x" onclick="evil' }, "x"),
    ).toBeNull();
    expect(passageHref({ ...passage, revision: "wrong" }, "x")).toBeNull();
  });
});

describe("literal safe snippet highlighting", () => {
  it("matches Chinese, case and full width forms while preserving source text", () => {
    const source = "缓存 ＣＡＣＨＥ 与 Cache";
    const segments = highlightSegments(source, "缓存 cache");
    expect(segments.map((s) => s.text).join("")).toBe(source);
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual([
      "缓存",
      "ＣＡＣＨＥ",
      "Cache",
    ]);
  });
  it("leaves markup inert and treats regex punctuation literally", () => {
    const source = "<img src=x onerror=alert(1)> [a+b] C++";
    expect(
      highlightSegments(source, "[a+b] C++")
        .filter((s) => s.match)
        .map((s) => s.text),
    ).toEqual(["[a+b]", "C++"]);
    expect(highlightSegments(source, "")).toEqual([
      { text: source, match: false },
    ]);
    expect(highlightSegments("", "x")).toEqual([]);
    expect(highlightSegments("nothing matches", "z")).toEqual([
      { text: "nothing matches", match: false },
    ]);
  });
  it("merges overlapping literal matches without duplicating text", () => {
    expect(highlightSegments("cachecache", "cache ache")).toEqual([
      { text: "cachecache", match: true },
    ]);
  });
});

describe("publication-aware passage targets", () => {
  it("does not interfere with headings or annotation links", () => {
    expect(
      passageTargetState("#annotation-123", revision, revision, true),
    ).toBe("ignore");
    expect(passageTargetState("#heading", revision, revision, false)).toBe(
      "ignore",
    );
  });
  it("distinguishes unchanged, updated, unverifiable and missing targets", () => {
    expect(passageTargetState(`#${anchor}`, revision, revision, true)).toBe(
      "ready",
    );
    expect(
      passageTargetState(`#${anchor}`, revision, "d".repeat(64), true),
    ).toBe("updated");
    expect(passageTargetState(`#${anchor}`, revision, undefined, true)).toBe(
      "unverified",
    );
    expect(passageTargetState(`#${anchor}`, null, revision, true)).toBe(
      "ready",
    );
    expect(passageTargetState(`#${anchor}`, revision, revision, false)).toBe(
      "missing",
    );
  });
});

describe("generated passage anchors preserve editorial siblings", () => {
  it("skips zero-text generated anchors while preserving captions and output blocks", () => {
    const caption = { matches: () => false };
    const before = { matches: () => true, previousElementSibling: caption };
    const output = { matches: () => false };
    const after = { matches: () => true, nextElementSibling: output };
    const current = {
      previousElementSibling: before,
      nextElementSibling: after,
    } as unknown as Element;
    expect(articleSibling(current, "previous")).toBe(caption);
    expect(articleSibling(current, "next")).toBe(output);
    expect(
      articleSibling(
        { previousElementSibling: null } as unknown as Element,
        "previous",
      ),
    ).toBeNull();
  });
  it("accepts safe anchor suffixes used to avoid heading collisions", () => {
    expect(
      passageHref({ ...passage, anchor: anchor + "-a-a" }, "cache"),
    ).toContain("#" + anchor + "-a-a");
    expect(
      passageTargetState("#" + anchor + "-a", revision, revision, true),
    ).toBe("ready");
  });
});

describe("unavailable publication recovery", () => {
  it("preserves the original query in a safe search URL only for passage links", () => {
    expect(passageRecoveryHref("#" + anchor, "?q=cache%26scope")).toBe(
      "/search/?q=cache%26scope",
    );
    expect(passageRecoveryHref("#" + anchor, "")).toBe("/search/");
    expect(passageRecoveryHref("#heading", "?q=cache")).toBeNull();
  });
});
