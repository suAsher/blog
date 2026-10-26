import { describe, expect, it } from "vitest";
import {
  constrainGraphNodes,
  graphTagColor,
  normalizeGraphSnapshot,
  neighborIds,
} from "../../src/lib/graph";

describe("knowledge graph data", () => {
  it("limits snapshots to 300 valid unique nodes and connected edges", () => {
    const snapshot = normalizeGraphSnapshot({
      nodes: Array.from({ length: 305 }, (_, index) => ({
        id: String(index),
        title: `Node ${index}`,
        tags: index === 0 ? ["learning"] : [],
        kind: "article",
      })),
      edges: [
        { source: "0", target: "1", kind: "wiki" },
        { source: "0", target: "missing", kind: "related" },
      ],
      totalNodes: 305,
      totalEdges: 2,
      truncated: true,
    });
    expect(snapshot.nodes).toHaveLength(300);
    expect(snapshot.edges).toEqual([
      { source: "0", target: "1", kind: "wiki" },
    ]);
    expect(snapshot.truncated).toBe(true);
  });

  it("keeps projected coordinates inside the visible canvas without mutation", () => {
    const original = [
      { id: "a", x: -100, y: 999 },
      { id: "b", x: Number.NaN, y: 45 },
    ];
    const result = constrainGraphNodes(original, 320, 180, 20);
    expect(result).toEqual([
      { id: "a", x: 20, y: 160 },
      { id: "b", x: 160, y: 45 },
    ]);
    expect(original[0]).toEqual({ id: "a", x: -100, y: 999 });
  });

  it("maps equal tags to equal palette colors and exposes direct neighbors", () => {
    expect(graphTagColor(["systems"])).toBe(graphTagColor(["systems"]));
    expect(graphTagColor([])).toMatch(/^#[0-9a-f]{6}$/i);
    expect(
      neighborIds("b", [
        { source: "a", target: "b", kind: "wiki" },
        { source: "b", target: "c", kind: "related" },
        { source: "x", target: "y", kind: "wiki" },
      ]),
    ).toEqual(new Set(["a", "c"]));
  });

  it("caps dense edge sets before layout work", () => {
    const snapshot = normalizeGraphSnapshot({
      nodes: Array.from({ length: 80 }, (_, index) => ({
        id: String(index),
        title: `Node ${index}`,
        tags: [],
        kind: "article",
      })),
      edges: Array.from({ length: 2_405 }, (_, index) => ({
        source: String(index % 79),
        target: String((index % 79) + 1),
        kind: index % 2 ? "wiki" : "related",
      })),
      totalNodes: 80,
      totalEdges: 2_405,
      truncated: false,
    });
    expect(snapshot.edges).toHaveLength(2_400);
    expect(snapshot.truncated).toBe(true);
  });
});
