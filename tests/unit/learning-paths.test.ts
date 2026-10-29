import { describe, expect, it } from "vitest";
import {
  learningProgress,
  moveLesson,
  validateLearningPath,
} from "../../src/lib/learning-paths";

describe("learning routes", () => {
  const chapters = [
    {
      id: "start",
      title: "起步",
      description: "",
      documentIds: ["a", "b", "c"],
    },
  ];
  it("counts published lessons only and resumes the first unfinished lesson", () => {
    expect(
      learningProgress(chapters, new Set(["a", "b"]), {
        a: { read: true },
      } as never),
    ).toEqual({ total: 2, completed: 1, percent: 50, next: "b" });
  });
  it("handles empty and completed routes without fake progress", () => {
    expect(learningProgress([], new Set(), {})).toEqual({
      total: 0,
      completed: 0,
      percent: 0,
      next: undefined,
    });
    expect(
      learningProgress(chapters, new Set(["a"]), { a: { read: true } } as never)
        .next,
    ).toBeUndefined();
  });
  it("reorders without mutating the chapter", () => {
    expect(moveLesson(["a", "b"], "b", -1)).toEqual(["b", "a"]);
    expect(moveLesson(["a"], "a", -1)).toEqual(["a"]);
    expect(moveLesson(["a"], "missing", 1)).toEqual(["a"]);
    expect(moveLesson(["a"], "a", 1)).toEqual(["a"]);
  });
  it("validates size budgets, identifiers, accent and chapter shape", () => {
    const valid = {
      title: "Go",
      description: "",
      accent: "blue" as const,
      chapters: [
        {
          id: "chapter_01",
          title: "起步",
          description: "",
          documentIds: ["a".repeat(32)],
        },
      ],
    };
    expect(validateLearningPath(valid)).toBe("");
    expect(
      validateLearningPath({ ...valid, title: "字".repeat(161) }),
    ).toBeTruthy();
    expect(
      validateLearningPath({ ...valid, description: "字".repeat(4001) }),
    ).toBeTruthy();
    expect(
      validateLearningPath({ ...valid, accent: "bad" as never }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: Array.from({ length: 31 }, (_, index) => ({
          ...valid.chapters[0],
          id: String(index),
        })),
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: [{ ...valid.chapters[0], title: "" }],
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: [{ ...valid.chapters[0], description: "字".repeat(2001) }],
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: [{ ...valid.chapters[0], id: "#invalid" }],
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: [{ ...valid.chapters[0], documentIds: ["invalid"] }],
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        ...valid,
        chapters: [
          valid.chapters[0],
          { ...valid.chapters[0], documentIds: [] },
        ],
      }),
    ).toBeTruthy();
  });
  it("rejects empty titles and duplicate references", () => {
    expect(
      validateLearningPath({
        title: "",
        description: "",
        accent: "mint",
        chapters: [],
      }),
    ).toBeTruthy();
    const id = "a".repeat(32);
    expect(
      validateLearningPath({
        title: "Go",
        description: "",
        accent: "mint",
        chapters: [{ ...chapters[0], documentIds: [id, id] }],
      }),
    ).toBeTruthy();
    expect(
      validateLearningPath({
        title: "Go",
        description: "",
        accent: "mint",
        chapters: [],
      }),
    ).toBe("");
  });
});
