import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboxQuery,
  readInboxFilter,
  readInboxOffset,
  selectInboxIds,
  validateInboxView,
  loadInbox,
  updateInboxStage,
  saveInboxViews,
} from "../../src/lib/inbox";
import { requestJSON } from "../../src/lib/documents";

vi.mock("../../src/lib/documents", () => ({
  requestJSON: vi.fn(),
  jsonRequest: (method: string, body: unknown) => ({
    method,
    body: JSON.stringify(body),
  }),
}));

describe("inbox filters and safe selection", () => {
  const id = "a".repeat(32);
  const filter = { view: "all" as const, q: "a & b", tag: "中文", routeId: id };
  beforeEach(() => vi.clearAllMocks());

  it("restores a bounded filter and preserves a removed route identifier", () => {
    expect(readInboxFilter(new URLSearchParams(inboxQuery(filter)))).toEqual(
      filter,
    );
    expect(
      readInboxFilter(new URLSearchParams("view=bad&routeId=bad")),
    ).toEqual({
      view: "pending",
      q: "",
      tag: "",
      routeId: "",
    });
    expect(
      readInboxFilter(
        new URLSearchParams({ q: "字".repeat(300), tag: "a".repeat(100) }),
      ).q,
    ).toHaveLength(256);
    expect(new URLSearchParams(inboxQuery(filter, 100)).get("offset")).toBe(
      "100",
    );
    expect(readInboxFilter(new URLSearchParams("view=verified")).view).toBe(
      "verified",
    );
  });

  it("selection is immutable, deduplicated, and never exceeds the batch budget", () => {
    const original = [id];
    expect(selectInboxIds(original, [id, "b".repeat(32)], true)).toEqual([
      id,
      "b".repeat(32),
    ]);
    expect(selectInboxIds(original, [id], false)).toEqual([]);
    expect(original).toEqual([id]);
    expect(
      selectInboxIds(
        [],
        Array.from({ length: 120 }, (_, n) => n.toString(16).padStart(32, "0")),
        true,
      ),
    ).toHaveLength(100);
    expect(selectInboxIds([], ["bad", id], true)).toEqual([id]);
  });

  it("restores a valid page and rejects malformed or oversized offsets", () => {
    expect(readInboxOffset(new URLSearchParams("offset=99"))).toBe(50);
    expect(readInboxOffset(new URLSearchParams())).toBe(0);
    for (const offset of ["bad", "-1", "3.5", "10001", "Infinity"]) {
      expect(readInboxOffset(new URLSearchParams({ offset }))).toBe(0);
    }
  });

  it("validates persisted views before a write while allowing stale route references", () => {
    const valid = { id: "view_1", name: "我的资料", filter };
    expect(validateInboxView(valid)).toBe("");
    for (const changed of [
      { name: "" },
      { name: "字".repeat(61) },
      { id: "../bad" },
      { filter: { ...filter, view: "bad" } },
      { filter: { ...filter, q: "字".repeat(257) } },
      { filter: { ...filter, tag: "字".repeat(81) } },
      { filter: { ...filter, routeId: "bad" } },
      { name: "bad\u0000" },
    ])
      expect(validateInboxView({ ...valid, ...changed } as never)).not.toBe("");
  });

  it("sends credentials through the existing request helper and preserves CAS revisions", async () => {
    vi.mocked(requestJSON).mockResolvedValue({ version: 3 });
    const controller = new AbortController();
    await loadInbox(filter, 50, controller.signal);
    expect(requestJSON).toHaveBeenLastCalledWith(
      `/api/inbox?${inboxQuery(filter, 50)}`,
      { signal: controller.signal },
    );
    await updateInboxStage(2, [id], "organized");
    expect(requestJSON).toHaveBeenLastCalledWith("/api/inbox/batch", {
      method: "PUT",
      body: JSON.stringify({
        version: 2,
        documentIds: [id],
        stage: "organized",
      }),
    });
    await saveInboxViews(3, []);
    expect(requestJSON).toHaveBeenLastCalledWith("/api/inbox/views", {
      method: "PUT",
      body: JSON.stringify({ version: 3, views: [] }),
    });
  });
});
