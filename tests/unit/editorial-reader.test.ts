import { describe, expect, it } from "vitest";
import {
  parseCodeCaption,
  articleOverview,
} from "../../src/lib/editorial-reader";

describe("editorial reading metadata", () => {
  it("accepts a visible bounded filename and explicit line ranges", () => {
    expect(parseCodeCaption("代码文件：main.go；重点行：2-4。", 10)).toEqual({
      filename: "main.go",
      highlights: [2, 3, 4],
    });
    expect(parseCodeCaption("代码文件：main.go；重点行：2-4,8", 10)).toEqual({
      filename: "main.go",
      highlights: [2, 3, 4, 8],
    });
    expect(parseCodeCaption("代码文件：demo/main.py", 3)).toEqual({
      filename: "demo/main.py",
      highlights: [],
    });
  });
  it("does not treat arbitrary paragraphs as code controls or accept unsafe paths", () => {
    for (const value of [
      "普通段落",
      "代码文件：../../secret",
      "代码文件：<img>.go",
      "代码文件：x.go；重点行：1-99999",
    ]) {
      expect(parseCodeCaption(value, 8)).toBeNull();
    }
  });
  it("bounds its line and caption budget", () => {
    expect(parseCodeCaption("代码文件：x.go；重点行：0,9", 8)).toBeNull();
    expect(parseCodeCaption("代码文件：" + "x".repeat(200), 8)).toBeNull();
  });
  it("derives a short overview without rewriting or inventing article content", () => {
    expect(
      articleOverview([
        { depth: 2, text: "问题", slug: "why" },
        { depth: 3, text: "细节", slug: "detail" },
        { depth: 2, text: "验证", slug: "check" },
      ]),
    ).toEqual([
      { text: "问题", slug: "why" },
      { text: "验证", slug: "check" },
    ]);
  });
});
