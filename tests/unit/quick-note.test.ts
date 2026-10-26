import { describe, expect, it } from "vitest";
import {
  quickNoteContent,
  quickNoteShortcut,
  matchesQuickNoteShortcut,
  QUICK_NOTE_KEY,
  retainedDraftAfterSave,
} from "../../src/lib/quick-note";

describe("quick capture", () => {
  it("keeps the complete original source and derives a codepoint-safe first-line title", () => {
    const source = "\n  # 灵感🌱  \n第二行";
    expect(quickNoteContent(source, "2026-10-26")).toEqual({
      title: "灵感🌱",
      source,
      date: "2026-10-26",
      kind: "note",
      description: "",
      tags: [],
      category: "",
      cover: "",
    });
    expect(
      Array.from(quickNoteContent("🌱".repeat(201), "2026-10-26").title),
    ).toHaveLength(200);
  });
  it("rejects empty capture instead of creating a fake activity", () => {
    expect(() => quickNoteContent(" \n\t", "2026-10-26")).toThrow(
      "先写下一点想法",
    );
  });
  it("defaults to an available shortcut and accepts only known stored choices", () => {
    expect(QUICK_NOTE_KEY).toBe("asher-quick-note-shortcut-v1");
    expect(quickNoteShortcut(null)).toBe("alt-n");
    expect(quickNoteShortcut("shift-u")).toBe("shift-u");
    expect(quickNoteShortcut("shift-n")).toBe("alt-n");
    expect(quickNoteShortcut("off")).toBe("off");
  });
  it("ignores composition, extra modifiers and disabled shortcuts", () => {
    const event = {
      key: "n",
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isComposing: false,
    };
    expect(matchesQuickNoteShortcut(event, "alt-n")).toBe(true);
    expect(matchesQuickNoteShortcut({ ...event, key: "N" }, "alt-n")).toBe(
      true,
    );
    expect(
      matchesQuickNoteShortcut({ ...event, isComposing: true }, "alt-n"),
    ).toBe(false);
    expect(
      matchesQuickNoteShortcut({ ...event, shiftKey: true }, "alt-n"),
    ).toBe(false);
    expect(matchesQuickNoteShortcut(event, "off")).toBe(false);
    expect(
      matchesQuickNoteShortcut(
        { ...event, key: "u", altKey: false, shiftKey: true },
        "shift-u",
      ),
    ).toBe(true);
  });
  it("clears only the source that actually finished saving", () => {
    expect(retainedDraftAfterSave("submitted", "submitted")).toBe("");
    expect(retainedDraftAfterSave("a newer thought", "submitted")).toBe(
      "a newer thought",
    );
  });
});
