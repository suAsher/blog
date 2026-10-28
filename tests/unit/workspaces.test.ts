import { describe, expect, it } from "vitest";
import {
  comparisonSelection,
  workspaceDocumentChoices,
  emptyWorkspace,
  moveDocument,
  removeDocument,
  validateWorkspace,
  boundedPosition,
  reapplyWorkspace,
  resolveWorkspaceDocuments,
} from "../../src/lib/workspaces";
import type { DocumentSummary } from "../../src/lib/documents";

const a = "a".repeat(32),
  b = "b".repeat(32),
  c = "c".repeat(32);
describe("topic workspace state", () => {
  it("selects distinct published articles when a second candidate is added", () => {
    expect(comparisonSelection([a, b], [a, a])).toEqual([a, b]);
    expect(comparisonSelection([a, b, c], [c, b])).toEqual([c, b]);
    expect(comparisonSelection([a], [c, b])).toEqual([a, a]);
    expect(comparisonSelection([], [a, b])).toEqual(["", ""]);
  });
  it("uses published metadata for published choices while retaining clearly labeled drafts", () => {
    const live = [
      {
        id: a,
        title: "Working secret",
        status: "published",
        version: 3,
        hasUnpublishedChanges: true,
      },
      { id: b, title: "Draft idea", status: "draft" },
    ] as DocumentSummary[];
    const published = [
      { id: a, title: "Published title", status: "published", version: 2 },
    ] as DocumentSummary[];
    expect(workspaceDocumentChoices(live, published)).toMatchObject([
      {
        id: a,
        title: "Published title",
        status: "published",
        version: 3,
        hasUnpublishedChanges: true,
      },
      { id: b, title: "Draft idea", status: "draft" },
    ]);
    expect(live[0].title).toBe("Working secret");
    expect(workspaceDocumentChoices(live, [])[0].title).toBe(
      "已发布文档（标题暂不可用）",
    );
  });
  it("reorders selected documents immutably without dropping unavailable references", () => {
    const ids = [a, b, c];
    expect(moveDocument(ids, b, -1)).toEqual([b, a, c]);
    expect(moveDocument(ids, a, -1)).toEqual(ids);
    expect(moveDocument(ids, c, 1)).toEqual(ids);
    expect(moveDocument(ids, "missing", 1)).toEqual(ids);
    expect(ids).toEqual([a, b, c]);
  });
  it("removes only explicitly selected references and their position", () => {
    const state = {
      ...emptyWorkspace(),
      documentIds: [a, b],
      positions: [
        { id: a, x: 10, y: 20 },
        { id: b, x: 30, y: 40 },
      ],
    };
    expect(removeDocument(state, a)).toMatchObject({
      documentIds: [b],
      positions: [{ id: b, x: 30, y: 40 }],
    });
    expect(state.documentIds).toEqual([a, b]);
  });
  it("validates server limits and identifiers before sending edits", () => {
    const state = {
      ...emptyWorkspace(),
      title: "A topic",
      documentIds: [a],
      questions: [{ id: "q_1", text: "Why?", done: false }],
    };
    expect(validateWorkspace(state)).toBe("");
    expect(validateWorkspace({ ...state, title: " " })).toContain("标题");
    expect(validateWorkspace({ ...state, title: "a".repeat(161) })).toContain(
      "标题",
    );
    expect(
      validateWorkspace({ ...state, description: "a".repeat(4001) }),
    ).toContain("说明");
    expect(validateWorkspace({ ...state, documentIds: [a, a] })).toContain(
      "文档",
    );
    expect(validateWorkspace({ ...state, documentIds: ["invalid"] })).toContain(
      "文档",
    );
    expect(
      validateWorkspace({
        ...state,
        questions: [{ id: "bad id", text: "Why", done: false }],
      }),
    ).toContain("问题");
    expect(
      validateWorkspace({
        ...state,
        questions: [{ id: "q", text: "", done: false }],
      }),
    ).toContain("问题");
    expect(
      validateWorkspace({ ...state, positions: [{ id: b, x: 1, y: 2 }] }),
    ).toContain("位置");
    expect(
      validateWorkspace({
        ...state,
        positions: [{ id: a, x: Infinity, y: 2 }],
      }),
    ).toContain("位置");
  });
  it("bounds finite positions and gives nonfinite coordinates a safe origin", () => {
    expect(boundedPosition(a, 100001, -100001)).toEqual({
      id: a,
      x: 100000,
      y: -100000,
    });
    expect(boundedPosition(a, NaN, Infinity)).toEqual({ id: a, x: 0, y: 0 });
  });
  it("reapplies local edits using the fresh remote version only after explicit choice", () => {
    const local = {
      ...emptyWorkspace(),
      title: "My edits",
      documentIds: [b],
      questions: [{ id: "q", text: "Keep this", done: true }],
    };
    const latest = {
      ...emptyWorkspace(),
      id: a,
      version: 8,
      title: "Remote",
      createdAt: "now",
      updatedAt: "later",
    };
    const merged = reapplyWorkspace(local, latest);
    expect(merged).toMatchObject({
      id: a,
      version: 8,
      title: "My edits",
      documentIds: [b],
      questions: local.questions,
    });
    expect(local).not.toHaveProperty("version");
    expect(merged.questions).not.toBe(local.questions);
  });
  it("keeps missing references visible and differentiates drafts from published content", () => {
    const docs = [
      { id: a, title: "Draft", status: "draft" },
      { id: b, title: "Published", status: "published" },
    ] as DocumentSummary[];
    expect(
      resolveWorkspaceDocuments([c, a, b], docs).map((item) => [
        item.id,
        item.availability,
      ]),
    ).toEqual([
      [c, "unavailable"],
      [a, "draft"],
      [b, "published"],
    ]);
  });
});
