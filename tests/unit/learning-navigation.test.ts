import { describe, expect, it } from "vitest";
import { lessonNeighbors } from "../../src/lib/learning-navigation";

describe("learning article sequence", () => {
  const chapters = [
    { title: "入门", documentIds: ["a", "draft", "b"] },
    { title: "进阶", documentIds: ["withdrawn", "c"] },
  ];
  it("crosses chapter boundaries using published documents only", () => {
    expect(lessonNeighbors(chapters, new Set(["a", "b", "c"]), "b")).toEqual({
      chapter: "入门",
      index: 2,
      total: 3,
      previous: "a",
      next: "c",
    });
  });
  it("does not invent a route for unavailable or unrelated documents", () => {
    expect(lessonNeighbors(chapters, new Set(["a", "b"]), "draft")).toBeNull();
    expect(lessonNeighbors(chapters, new Set(["a"]), "other")).toBeNull();
  });
  it("has honest first and final lesson boundaries", () => {
    expect(lessonNeighbors(chapters, new Set(["a"]), "a")).toEqual({
      chapter: "入门",
      index: 1,
      total: 1,
      previous: null,
      next: null,
    });
  });
});
