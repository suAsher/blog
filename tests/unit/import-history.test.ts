import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildImportDecisions,
  importDocuments,
  listImportReports,
  listRevisions,
  getRevision,
  compareContent,
  previewImport,
  restoreRevision,
} from "../../src/lib/import-inbox";
import type { DocumentContent } from "../../src/lib/documents";

const content: DocumentContent = {
  title: "Old title",
  description: "",
  date: "2026-10-28",
  tags: ["a"],
  category: "",
  cover: "",
  source: "first\nold\nlast",
};
afterEach(() => vi.unstubAllGlobals());

describe("import decisions", () => {
  it("defaults existing paths to skip and carries the preview version for explicit updates", () => {
    const candidates = [
      { path: "new.md", title: "New", status: "new" as const },
      {
        path: "old.md",
        title: "Old",
        status: "changed" as const,
        existingId: "id",
        version: 4,
      },
      { path: "bad.md", title: "", status: "invalid" as const },
    ];
    expect(buildImportDecisions(candidates, { "old.md": "update" })).toEqual([
      { path: "new.md", action: "create" },
      { path: "old.md", action: "update", existingId: "id", version: 4 },
      { path: "bad.md", action: "skip" },
    ]);
    expect(buildImportDecisions(candidates, {})[1].action).toBe("skip");
  });

  it("posts the actual files and relative paths to the read-only preview endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { candidates: [] } })),
      );
    vi.stubGlobal("fetch", fetch);
    const file = new File(["# source"], "note.md");
    await previewImport([{ file, path: "folder/note.md" }]);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("/api/import/preview");
    expect(request.method).toBe("POST");
    expect(request.body.get("paths")).toBe('["folder/note.md"]');
    expect(await request.body.get("files").text()).toBe("# source");
  });
});

describe("revision comparison", () => {
  it("compares title, metadata and source without inserting unsafe markup", () => {
    const diff = compareContent(content, {
      ...content,
      title: "<script>title</script>",
      tags: ["b"],
      source: "first\nnew\nlast",
    });
    expect(diff.fields.map((field) => field.key)).toEqual(["title", "tags"]);
    expect(diff.lines).toEqual([
      { kind: "same", text: "first" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "same", text: "last" },
    ]);
    expect(diff.fields[0].after).toBe("<script>title</script>");
    expect(diff.truncated).toBe(false);
  });

  it("bounds work and output for huge sources while reporting truncation", () => {
    const diff = compareContent(content, {
      ...content,
      source: "x\n".repeat(10000),
    });
    expect(diff.lines.length).toBeLessThanOrEqual(400);
    expect(diff.truncated).toBe(true);
  });

  it("restores by revision using the current working version for concurrency checks", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, data: { id: "doc", version: 9 } }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(restoreRevision("a/b", 8, 3)).resolves.toMatchObject({
      version: 9,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/documents/a%2Fb/history",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 8, revision: 3 }),
      }),
    );
  });
});

it("bounds a single oversized line as well as the line count", () => {
  const diff = compareContent(content, {
    ...content,
    source: "<unsafe>".repeat(10000),
  });
  expect(diff.lines.every((line) => line.text.length <= 2000)).toBe(true);
  expect(diff.truncated).toBe(true);
});

it("returns no changes for identical content and compares optional metadata predictably", () => {
  const unchanged = compareContent(content, { ...content });
  expect(unchanged.fields).toEqual([]);
  expect(unchanged.sourceChanged).toBe(false);
  expect(
    compareContent(content, { ...content, kind: "note", related: ["one"] })
      .fields,
  ).toMatchObject([
    { key: "kind", after: "note" },
    { key: "related", after: "one" },
  ]);
});

it("limits metadata output and marks content beyond the comparison budget", () => {
  const diff = compareContent(content, {
    ...content,
    description: "x".repeat(10000),
  });
  expect(diff.fields[0].after.length).toBeLessThanOrEqual(2000);
  expect(diff.truncated).toBe(true);
});

it("commits multipart decisions with a stable retry identity and reopens persisted reports", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { reports: [] } })),
    );
  vi.stubGlobal("fetch", fetch);
  await importDocuments(
    [{ file: new File(["body"], "a.md"), path: "notes/a.md" }],
    [
      {
        path: "notes/a.md",
        action: "update",
        existingId: "document",
        version: 7,
      },
    ],
    "retry-identity",
  );
  const [url, request] = fetch.mock.calls[0];
  expect(url).toBe("/api/import");
  expect(JSON.parse(request.body.get("decisions"))).toEqual({
    requestId: "retry-identity",
    paths: [
      {
        path: "notes/a.md",
        action: "update",
        existingId: "document",
        version: 7,
      },
    ],
  });
  expect(await listImportReports()).toEqual({ reports: [] });
  expect(fetch.mock.calls[1][0]).toBe("/api/import/reports");
});

it("reads version summaries and a selected revision from the server", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify({ ok: true, data: {} })),
    );
  vi.stubGlobal("fetch", fetch);
  await listRevisions("a/b");
  await getRevision("a/b", 12);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([
    "/api/documents/a%2Fb/history",
    "/api/documents/a%2Fb/history?revision=12",
  ]);
});
