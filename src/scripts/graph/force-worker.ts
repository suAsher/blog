import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { constrainGraphNodes, type GraphEdge, type GraphNode } from "../../lib/graph";

interface ForceNode extends GraphNode, SimulationNodeDatum {
  x: number;
  y: number;
}

type WorkerMessage =
  | {
      type: "init";
      nodes: GraphNode[];
      edges: GraphEdge[];
      width: number;
      height: number;
      reducedMotion: boolean;
    }
  | { type: "resize"; width: number; height: number }
  | { type: "pause"; paused: boolean }
  | { type: "drag"; id: string; x?: number; y?: number; active: boolean };

let simulation: Simulation<ForceNode, GraphEdge> | undefined;
let nodes: ForceNode[] = [];
let width = 800;
let height = 560;
let tickCount = 0;
let reducedMotion = false;

function send(done = false): void {
  const bounded = constrainGraphNodes(
    nodes.map((node) => ({ id: node.id, x: node.x, y: node.y })),
    width,
    height,
    28,
  );
  self.postMessage({ type: "positions", nodes: bounded, done });
}

function initialPosition(index: number, total: number): { x: number; y: number } {
  const angle = index * 2.399963229728653;
  const radius = Math.sqrt(index / Math.max(1, total)) * Math.min(width, height) * 0.34;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

function initialize(message: Extract<WorkerMessage, { type: "init" }>): void {
  simulation?.stop();
  reducedMotion = message.reducedMotion;
  width = Math.max(240, message.width);
  height = Math.max(240, message.height);
  nodes = message.nodes.map((node, index) => ({
    ...node,
    ...initialPosition(index, message.nodes.length),
  }));
  const edges = message.edges.map((edge) => ({ ...edge }));
  simulation = forceSimulation<ForceNode>(nodes)
    .force(
      "link",
      forceLink<ForceNode, GraphEdge>(edges)
        .id((node) => node.id)
        .distance((edge) => (edge.kind === "related" ? 92 : 70))
        .strength(0.34),
    )
    .force("charge", forceManyBody().strength(-115).distanceMax(360))
    .force("collision", forceCollide<ForceNode>().radius(18).strength(0.8))
    .force("center", forceCenter(width / 2, height / 2))
    .force("x", forceX(width / 2).strength(0.025))
    .force("y", forceY(height / 2).strength(0.025));

  if (message.reducedMotion) {
    simulation.stop();
    for (let index = 0; index < 260; index += 1) simulation.tick();
    send(true);
    return;
  }
  // Paint the deterministic seed immediately; dense snapshots can then refine
  // in the worker without holding the first usable canvas frame.
  send(false);
  simulation.on("tick", () => {
    tickCount += 1;
    const alpha = simulation?.alpha() ?? 0;
    if (tickCount % 2 === 0) send(alpha < 0.025);
    if (alpha < 0.025) simulation?.stop();
  });
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === "init") return initialize(message);
  if (!simulation) return;
  if (message.type === "pause") {
    if (message.paused) simulation.stop();
    else if (simulation.alpha() >= 0.025) simulation.restart();
    return;
  }
  if (message.type === "resize") {
    width = Math.max(240, message.width);
    height = Math.max(240, message.height);
    simulation.force("center", forceCenter(width / 2, height / 2));
    simulation.force("x", forceX(width / 2).strength(0.025));
    simulation.force("y", forceY(height / 2).strength(0.025));
    if (reducedMotion) {
      simulation.stop();
      for (let index = 0; index < 120; index += 1) simulation.tick();
      send(true);
      return;
    }
    simulation.alpha(0.24).restart();
    return;
  }
  const node = nodes.find((item) => item.id === message.id);
  if (!node) return;
  node.fx = message.active ? message.x ?? node.x : null;
  node.fy = message.active ? message.y ?? node.y : null;
  simulation.alphaTarget(message.active ? 0.16 : 0);
  simulation.alpha(Math.max(simulation.alpha(), 0.18)).restart();
};
