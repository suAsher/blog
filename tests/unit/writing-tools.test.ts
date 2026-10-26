import { describe, expect, it } from "vitest";
import {
  commandSnippet,
  draftTemplate,
  imageValidationMessage,
  manageIntent,
  mapSelection,
  sanitizeDraftTitle,
  slashCommand,
  writingCommands,
} from "../../src/lib/writing-tools";

describe("writing commands", () => {
  it("provides usable Markdown for every command and keeps selected text", () => {
    for (const command of writingCommands)
      expect(commandSnippet(command.id)).not.toBe("");
    expect(commandSnippet("bold", "保留原文")).toBe("**保留原文**");
    expect(commandSnippet("heading", "标题")).toContain("## 标题");
    expect(commandSnippet("code", "const a = 1;")).toContain("const a = 1;");
    expect(commandSnippet("link", "说明")).toContain("[说明]");
    expect(commandSnippet("unknown")).toBe("");
  });
  it("only opens a slash command at a plain line start, outside code fences", () => {
    expect(slashCommand("正文\n  /cha", 9, 9)).toEqual({
      start: 5,
      end: 9,
      query: "cha",
    });
    expect(slashCommand("/", 1, 1)).toEqual({ start: 0, end: 1, query: "" });
    for (const value of ["https://example/", "正文 /", "```text\n/", "~~~~\n/"])
      expect(slashCommand(value, value.length, value.length)).toBeNull();
    const closed = "```\ncode\n```\n/";
    expect(slashCommand(closed, closed.length, closed.length)).not.toBeNull();
    expect(slashCommand("/abc", 2, 3)).toBeNull();
    expect(slashCommand("/too long command", 17, 17)).toBeNull();
  });
  it("recognizes safe startup intents and gives existing documents priority", () => {
    expect(manageIntent(new URLSearchParams("new=1"))).toEqual({
      kind: "new",
      title: "",
    });
    expect(
      manageIntent(
        new URLSearchParams(
          `new=1&title=${encodeURIComponent(` \u0007${"🌱".repeat(205)} `)}`,
        ),
      ),
    ).toEqual({ kind: "new", title: "🌱".repeat(200) });
    expect(manageIntent(new URLSearchParams("template=chart"))).toEqual({
      kind: "template",
      template: "chart",
    });
    expect(manageIntent(new URLSearchParams("template=mermaid"))).toEqual({
      kind: "template",
      template: "mermaid",
    });
    expect(manageIntent(new URLSearchParams("template=note"))).toEqual({
      kind: "template",
      template: "note",
    });
    expect(manageIntent(new URLSearchParams("template=__proto__"))).toBeNull();
    expect(
      manageIntent(new URLSearchParams("id=" + "a".repeat(32) + "&new=1")),
    ).toEqual({ kind: "document", id: "a".repeat(32) });
    expect(manageIntent(new URLSearchParams("id=bad&import=1"))).toEqual({
      kind: "import",
    });
    expect(manageIntent(new URLSearchParams())).toBeNull();
  });
  it("sanitizes a requested new-document title by Unicode code point", () => {
    expect(sanitizeDraftTitle("  学习\u0000计划  ")).toBe("学习计划");
    expect(Array.from(sanitizeDraftTitle("𠮷".repeat(201)))).toHaveLength(200);
    expect(sanitizeDraftTitle("\u0000\u0007")).toBe("");
  });
  it("creates explicitly labeled independent draft templates", () => {
    for (const name of ["mermaid", "chart", "note"] as const) {
      const template = draftTemplate(name);
      expect(template.source).toContain("演示");
      expect(template.title).toContain("演示");
      expect(template.description).toContain("模板");
    }
    expect(draftTemplate("mermaid").source).toContain("```mermaid");
    expect(draftTemplate("chart").source).toContain("```chart");
    expect(draftTemplate("note").source).toContain("[!NOTE]");
  });
});

describe("image paste and asynchronous selection", () => {
  it("accepts supported image files only within the size limit", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"])
      expect(imageValidationMessage({ type, size: 8 * 1024 * 1024 })).toBe("");
    expect(
      imageValidationMessage({ type: "image/svg+xml", size: 10 }),
    ).toContain("PNG");
    expect(imageValidationMessage({ type: "image/png", size: 0 })).toContain(
      "为空",
    );
    expect(
      imageValidationMessage({ type: "image/png", size: 8 * 1024 * 1024 + 1 }),
    ).toContain("8 MB");
  });
  it("keeps the upload anchor when later text is typed and shifts for earlier edits", () => {
    expect(
      mapSelection("before after", "before new after", { start: 7, end: 7 }),
    ).toEqual({ start: 7, end: 7 });
    expect(
      mapSelection("abc def", "prefix abc def", { start: 4, end: 4 }),
    ).toEqual({ start: 11, end: 11 });
    expect(mapSelection("abc def", "a def", { start: 4, end: 4 })).toEqual({
      start: 2,
      end: 2,
    });
    expect(mapSelection("abc def", "abc def!", { start: 0, end: 3 })).toEqual({
      start: 0,
      end: 3,
    });
    expect(mapSelection("abc def", "aXYZ def", { start: 1, end: 3 })).toEqual({
      start: 4,
      end: 4,
    });
    expect(mapSelection("same", "same", { start: 2, end: 2 })).toEqual({
      start: 2,
      end: 2,
    });
  });
});
