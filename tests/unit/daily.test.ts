import { describe, expect, it } from "vitest";
import {
  activityCalendar,
  continuingDocuments,
  dailyDocumentHref,
  isLatestDashboardRequest,
  reviewDocuments,
} from "../../src/lib/daily";
import type { SearchArticle } from "../../src/lib/search";

describe("today helpers", () => {
  it("aligns activity by calendar dates and marks unknown history honestly", () => {
    const days = activityCalendar(
      "2026-03-10",
      [{ date: "2026-03-09", count: 2 }],
      "2026-03-09",
      3,
    );
    expect(days).toEqual([
      { date: "2026-03-08", count: 0, known: false },
      { date: "2026-03-09", count: 2, known: true },
      { date: "2026-03-10", count: 0, known: true },
    ]);
    expect(activityCalendar("2026-03-10", [], null, 1)[0].known).toBe(false);
    expect(activityCalendar("invalid", [], null)).toEqual([]);
  });
  it("ignores invalid counts without inventing positive activity", () => {
    expect(
      activityCalendar(
        "2026-01-01",
        [{ date: "2026-01-01", count: -3 }],
        "2026-01-01",
        1,
      )[0].count,
    ).toBe(0);
  });
  it("continues only unfinished actual reading ordered by last visit", () => {
    const docs = [{ id: "a" }, { id: "b" }, { id: "c" }] as SearchArticle[];
    const entry = {
      bookmarked: false,
      progress: 45,
      read: false,
      updatedAt: 10,
    };
    expect(
      continuingDocuments(docs, {
        a: entry,
        b: { ...entry, updatedAt: 20 },
        c: { ...entry, read: true },
      }).map((doc) => doc.id),
    ).toEqual(["b", "a"]);
  });
  it("opens drafts in writing and published documents at canonical URLs", () => {
    expect(dailyDocumentHref({ id: "abc", status: "draft" })).toBe(
      "/manage/?id=abc",
    );
    expect(dailyDocumentHref({ id: "abc", status: "published" })).toBe(
      "/articles/abc/",
    );
  });
  it("renders only the latest dashboard response", () => {
    expect(isLatestDashboardRequest(3, 3)).toBe(true);
    expect(isLatestDashboardRequest(2, 3)).toBe(false);
  });
  it("keeps articles but excludes quick notes from review choices", () => {
    const documents = [
      { id: "article", kind: "article" },
      { id: "legacy" },
      { id: "note", kind: "note" },
    ] as SearchArticle[];
    expect(reviewDocuments(documents).map((document) => document.id)).toEqual([
      "article",
      "legacy",
    ]);
  });
});
