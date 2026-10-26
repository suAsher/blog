import { describe, expect, it } from "vitest";
import {
  applyWikiCompletion,
  wikiCompletionRange,
} from "../../src/lib/wikilinks";

describe("wiki-link completion", () => {
  it("finds the unfinished wiki link at a collapsed cursor", () => {
    expect(wikiCompletionRange("See [[lear", 10, 10)).toEqual({
      start: 4,
      end: 10,
      query: "lear",
    });
    expect(wikiCompletionRange("[[", 2, 2)).toEqual({
      start: 0,
      end: 2,
      query: "",
    });
  });

  it("does not complete inside code or after a closed link", () => {
    for (const source of [
      "`inline [[query`",
      "````ts\n[[query",
      "~~~\n[[query",
      "```js\ncode\n```not-a-close\n[[query",
      "already [[closed]]",
      "line [[one\nquery",
    ]) {
      expect(
        wikiCompletionRange(source, source.length, source.length),
      ).toBeNull();
    }
    const closedFence = "```\n[[ignored\n```\n[[ready";
    expect(
      wikiCompletionRange(closedFence, closedFence.length, closedFence.length)
        ?.query,
    ).toBe("ready");
  });

  it("ignores selections and rejects control characters", () => {
    expect(wikiCompletionRange("[[topic", 2, 7)).toBeNull();
    expect(wikiCompletionRange("[[bad\u0000", 6, 6)).toBeNull();
  });

  it("inserts a stable id and visible title without altering surrounding text", () => {
    const token = `[[${"a".repeat(32)}|Learning Systems]]`;
    expect(
      applyWikiCompletion("Before [[learn after", { start: 7, end: 14 }, {
        id: "a".repeat(32),
        title: "Learning Systems",
      }),
    ).toEqual({
      value: `Before ${token} after`,
      cursor: 7 + token.length,
    });
  });
});
