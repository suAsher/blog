import { describe, expect, it } from "vitest";
import { learningPractice, learningLines, practiceUpdate, updateLearningChapter } from "../../src/lib/learning-practice";
import { validateLearningPath, type LearningPath } from "../../src/lib/learning-paths";

const path: LearningPath = {
  id: "a".repeat(32), title: "一条路线", description: "说明", accent: "blue",
  version: 3, createdAt: "2026-10-31", updatedAt: "2026-10-31",
  objectives: ["解释机制"], prerequisites: ["能运行本地程序"],
  chapters: [
    { id: "first", title: "起步", description: "", documentIds: [], goal: "理解输入", exercise: "提交一段可复现代码", practiced: true },
    { id: "second", title: "验证", description: "", documentIds: [], exercise: "记录失败分支" },
    { id: "legacy", title: "旧章", description: "", documentIds: [], practiced: true },
  ],
};
describe("practice is independent from read progress", () => {
  it("counts only explicit exercises, with a truthful empty state", () => {
    expect(learningPractice(path.chapters)).toEqual({ total: 2, completed: 1, percent: 50, next: "second" });
    expect(learningPractice([])).toEqual({ total: 0, completed: 0, percent: 0, next: undefined });
    expect(learningPractice([{ ...path.chapters[1], practiced: true }]).next).toBeUndefined();
  });
  it("builds an immutable CAS update preserving every chapter and route metadata", () => {
    const result = practiceUpdate(path, "second", true);
    expect(path.chapters[1].practiced).toBeUndefined();
    expect(result.version).toBe(3);
    expect(result.objectives).toEqual(path.objectives);
    expect(result.prerequisites).toEqual(path.prerequisites);
    expect(result.chapters[1].practiced).toBe(true);
    expect(result.chapters[0]).toEqual(path.chapters[0]);
    expect(result).not.toHaveProperty("id");
    expect(practiceUpdate(path, "first", false).chapters[0].practiced).toBe(false);
    expect(() => practiceUpdate(path, "missing", true)).toThrow();
    expect(() => practiceUpdate(path, "legacy", true)).toThrow();
  });
  it("parses editable lines without silently truncating", () => {
    expect(learningLines(" A \n\n B \r\n")).toEqual(["A", "B"]);
    expect(learningLines(Array(9).fill("x").join("\n"))).toHaveLength(9);
  });
  it("resets practice only when the exercise actually changes", () => {
    const original = path.chapters[0];
    expect(updateLearningChapter(original, { exercise: "提交新的排错记录" }).practiced).toBe(false);
    expect(updateLearningChapter(original, { exercise: original.exercise }).practiced).toBe(true);
    expect(updateLearningChapter(original, { title: "修改章节名称" }).practiced).toBe(true);
    expect(updateLearningChapter(original, { exercise: "" }).practiced).toBe(false);
    expect(original.practiced).toBe(true);
  });
  it("validates optional metadata budgets and keeps legacy routes valid", () => {
    expect(validateLearningPath(path)).toBe("");
    expect(validateLearningPath({ ...path, objectives: [], prerequisites: [] })).toBe("");
    for (const patch of [
      { objectives: Array(9).fill("x") }, { objectives: [" "] },
      { prerequisites: ["x".repeat(241)] }, { prerequisites: ["x\nline"] },
      { chapters: [{ ...path.chapters[0], goal: "字".repeat(801) }] },
      { chapters: [{ ...path.chapters[0], exercise: "字".repeat(2001) }] },
      { chapters: [{ ...path.chapters[0], practiced: "yes" as never }] },
    ]) expect(validateLearningPath({ ...path, ...patch })).not.toBe("");
  });
});
