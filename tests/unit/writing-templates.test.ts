import { describe, expect, it } from "vitest";
import {
  writingTemplateOptions,
  writingTemplateDraft,
  explorerMarkdown,
} from "../../src/lib/writing-templates";
import { parseExplorer } from "../../src/lib/explorers";

describe("authoring templates", () => {
  it("keeps blank drafts blank and generates distinct editable structures", () => {
    expect(writingTemplateDraft("blank")).toEqual({
      title: "未命名文档",
      description: "",
      source: "",
    });
    const structures = writingTemplateOptions
      .filter((item) => item.id !== "blank")
      .map((item) => writingTemplateDraft(item.id));
    expect(new Set(structures.map((item) => item.source)).size).toBe(4);
    for (const item of structures) {
      expect(item.source).toContain("写作骨架");
      expect(item.source).toContain("待填写");
      expect(item.source).toContain("## 来源");
      expect(item.source).not.toContain("生产实测");
    }
    expect(structures[0].source).toContain("验证结果");
    expect(structures[1].source).toContain("反例与边界");
    expect(structures[2].source).toContain("事实与假设");
    expect(structures[3].source).toContain("适用条件");
  });

  it("returns independent draft objects and rejects unknown identifiers", () => {
    const first = writingTemplateDraft("tutorial");
    first.source = "edited";
    expect(writingTemplateDraft("tutorial").source).not.toBe("edited");
    expect(() => writingTemplateDraft("__proto__" as "blank")).toThrow();
  });
});

describe("controlled experiment authoring", () => {
  it.each(["inference", "go-request", "network"])(
    "creates safe %s Markdown",
    (kind) => {
      const markdown = explorerMarkdown(kind, " 一个可验证的问题 ");
      const definition = markdown.split("\n").slice(2, -2).join("\n");
      expect(parseExplorer(definition)).toEqual({
        kind,
        title: "一个可验证的问题",
      });
      expect(markdown).toMatch(/^\n```explore\n/);
    },
  );

  it("uses the model default when title is empty", () => {
    expect(explorerMarkdown("network", " ")).toContain('"kind": "network"');
    expect(explorerMarkdown("network", " ")).not.toContain('"title"');
  });

  it("rejects unsupported models and titles outside the renderer budget", () => {
    expect(() => explorerMarkdown("javascript", "title")).toThrow();
    expect(() => explorerMarkdown("network", "a".repeat(121))).toThrow();
  });

  it("keeps hostile-looking titles inside JSON strings rather than Markdown or HTML", () => {
    const title = "```\n<img src=x onerror=alert(1)>";
    const markdown = explorerMarkdown("network", title);
    expect(markdown.split("\n").filter((line) => line === "```")).toHaveLength(
      1,
    );
    expect(
      parseExplorer(markdown.split("\n").slice(2, -2).join("\n")).title,
    ).toBe(title);
  });
});
