export type GraphEdgeKind = "wiki" | "related";

export interface GraphNode {
  id: string;
  title: string;
  tags: string[];
  kind: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
}

export interface PositionedGraphNode {
  id: string;
  x: number;
  y: number;
}

const GRAPH_LIMIT = 300;
const GRAPH_EDGE_LIMIT = 2400;
const GRAPH_PALETTE = [
  "#78e0bd",
  "#91bff1",
  "#b39ae8",
  "#efb77d",
  "#e8889d",
  "#82d7df",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validNode(value: unknown): value is GraphNode {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === "string") &&
    typeof value.kind === "string"
  );
}

function validEdge(value: unknown): value is GraphEdge {
  if (!isRecord(value)) return false;
  return (
    typeof value.source === "string" &&
    typeof value.target === "string" &&
    (value.kind === "wiki" || value.kind === "related")
  );
}

export function normalizeGraphSnapshot(value: unknown): GraphSnapshot {
  const record = isRecord(value) ? value : {};
  const seen = new Set<string>();
  const nodes = (Array.isArray(record.nodes) ? record.nodes : [])
    .filter(validNode)
    .filter((node) => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return true;
    })
    .slice(0, GRAPH_LIMIT)
    .map((node) => ({ ...node, tags: [...node.tags] }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedEdges = (Array.isArray(record.edges) ? record.edges : [])
    .filter(validEdge)
    .filter(
      (edge) =>
        edge.source !== edge.target &&
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target),
    );
  const edges = connectedEdges
    .slice(0, GRAPH_EDGE_LIMIT)
    .map((edge) => ({ ...edge }));
  return {
    nodes,
    edges,
    totalNodes:
      typeof record.totalNodes === "number" ? record.totalNodes : nodes.length,
    totalEdges:
      typeof record.totalEdges === "number" ? record.totalEdges : edges.length,
    truncated:
      Boolean(record.truncated) ||
      seen.size > GRAPH_LIMIT ||
      connectedEdges.length > GRAPH_EDGE_LIMIT,
  };
}

export function constrainGraphNodes<T extends PositionedGraphNode>(
  nodes: readonly T[],
  width: number,
  height: number,
  padding = 24,
): T[] {
  const safeWidth = Math.max(padding * 2, width);
  const safeHeight = Math.max(padding * 2, height);
  return nodes.map((node) => ({
    ...node,
    x: Number.isFinite(node.x)
      ? Math.min(safeWidth - padding, Math.max(padding, node.x))
      : safeWidth / 2,
    y: Number.isFinite(node.y)
      ? Math.min(safeHeight - padding, Math.max(padding, node.y))
      : safeHeight / 2,
  }));
}

export function graphTagColor(tags: readonly string[]): string {
  const value = tags[0]?.trim().toLocaleLowerCase() || "untagged";
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return GRAPH_PALETTE[Math.abs(hash) % GRAPH_PALETTE.length];
}

export function neighborIds(
  id: string,
  edges: readonly GraphEdge[],
): Set<string> {
  return new Set(
    edges.flatMap((edge) =>
      edge.source === id
        ? [edge.target]
        : edge.target === id
          ? [edge.source]
          : [],
    ),
  );
}
