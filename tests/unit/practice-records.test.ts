import { describe, expect, it } from "vitest";
import {
  practiceRecordDraft,
  practiceRecordUpdate,
} from "../../src/lib/practice-records";
import {
  learningProgress,
  validateLearningPath,
  type LearningPath,
} from "../../src/lib/learning-paths";
import {
  learningPractice,
  updateLearningChapter,
} from "../../src/lib/learning-practice";

const id = "a".repeat(32),
  other = "b".repeat(32);
const path: LearningPath = {
  id: "c".repeat(32),
  title: "系统理解",
  description: "一条路线",
  accent: "mint",
  version: 3,
  createdAt: "2026-11-01",
  updatedAt: "2026-11-01",
  objectives: ["建立证据"],
  prerequisites: ["基础阅读"],
  chapters: [
    {
      id: "first",
      title: "第一章",
      description: "导读",
      documentIds: [other],
      exercise: "实验记录",
      practiced: true,
    },
  ],
};

describe("practice records", () => {
  it("attaches and removes immutably while preserving route CAS and completion", () => {
    const attached = practiceRecordUpdate(path, "first", id, "attach");
    expect(attached.version).toBe(3);
    expect(attached).not.toHaveProperty("id");
    expect(attached.chapters[0].practiceDocumentIds).toEqual([id]);
    expect(attached.chapters[0].documentIds).toEqual([other]);
    expect(attached.chapters[0].practiced).toBe(true);
    expect(attached.objectives).toEqual(path.objectives);
    expect(attached.prerequisites).toEqual(path.prerequisites);
    expect(path.chapters[0].practiceDocumentIds).toBeUndefined();
    const next = { ...path, ...attached };
    expect(
      practiceRecordUpdate(next, "first", id, "attach").chapters[0]
        .practiceDocumentIds,
    ).toEqual([id]);
    expect(
      practiceRecordUpdate(next, "first", id, "remove").chapters[0]
        .practiceDocumentIds,
    ).toEqual([]);
    expect(
      updateLearningChapter(next.chapters[0], { exercise: "新实验" })
        .practiceDocumentIds,
    ).toEqual([id]);
  });
  it("never counts evidence as reading or practiced", () => {
    const chapter = {
      ...path.chapters[0],
      practiced: false,
      practiceDocumentIds: [id],
    };
    expect(
      learningProgress([chapter], new Set([id, other]), {
        [id]: { read: true },
      } as never),
    ).toMatchObject({ completed: 0, total: 1 });
    expect(learningPractice([chapter]).completed).toBe(0);
  });
  it("rejects removed chapters, invalid ids, per-chapter duplicates and budgets", () => {
    expect(() => practiceRecordUpdate(path, "gone", id, "attach")).toThrow(
      "章节",
    );
    expect(() =>
      practiceRecordUpdate(path, "first", "../bad", "attach"),
    ).toThrow();
    const ids = Array.from({ length: 21 }, (_, i) =>
      i.toString(16).padStart(32, "0"),
    );
    for (const invalid of [[id, id], ["bad"], ids, null, 4]) {
      expect(
        validateLearningPath({
          ...path,
          chapters: [
            { ...path.chapters[0], practiceDocumentIds: invalid as never },
          ],
        }),
      ).not.toBe("");
    }
    const full = {
      ...path,
      chapters: [
        { ...path.chapters[0], practiceDocumentIds: ids.slice(0, 20) },
      ],
    };
    expect(() => practiceRecordUpdate(full, "first", id, "attach")).toThrow();
    const many = Array.from({ length: 5 }, (_, i) => ({
      ...path.chapters[0],
      id: `c${i}`,
      documentIds: [],
      practiceDocumentIds: ids.slice(0, 20),
    }));
    expect(validateLearningPath({ ...path, chapters: many })).toBe("");
    expect(
      validateLearningPath({
        ...path,
        chapters: [
          ...many,
          { ...many[0], id: "last", practiceDocumentIds: [id] },
        ],
      }),
    ).not.toBe("");
    expect(
      validateLearningPath({
        ...path,
        chapters: [{ ...path.chapters[0], practiceDocumentIds: [] }],
      }),
    ).toBe("");
  });
  it("creates only an honest draft skeleton with useful evidence sections", () => {
    const draft = practiceRecordDraft(
      path,
      "first",
      "验证超时",
      new Date("2026-11-05T09:00:00Z"),
    );
    expect(draft.title).toBe("验证超时");
    expect(draft.description).toBe(
      "记录本章实践的环境、步骤、结果与复盘，尚待验证。",
    );
    expect(draft.date).toBe("2026-11-05");
    expect(draft.kind).toBe("note");
    expect(draft).not.toHaveProperty("status");
    expect(draft.source).toContain("尚未完成验证");
    for (const section of [
      "操作步骤",
      "代码与命令",
      "预期与实际结果",
      "截图与附件",
      "失败原因",
      "复盘与下一步",
    ])
      expect(draft.source).toContain(`## ${section}`);
    expect(draft.source).toContain(`/learn/?id=${path.id}#chapter-first`);
    expect(draft.source).toContain("实验记录");
    expect(() => practiceRecordDraft(path, "missing", "a")).toThrow();
    expect(() => practiceRecordDraft(path, "first", " ")).toThrow();
    expect(() =>
      practiceRecordDraft(path, "first", "界".repeat(161)),
    ).toThrow();
    const crafted = {
      ...path,
      title: "[link](javascript:alert(1))",
      chapters: [{ ...path.chapters[0], exercise: "[[secret]]\n## injected" }],
    };
    expect(practiceRecordDraft(crafted, "first", "标题").source).not.toContain(
      "[[secret]]",
    );
    expect(practiceRecordDraft(crafted, "first", "标题").source).not.toContain(
      "\n## injected",
    );
  });
});
