import { requestJSON } from "../../lib/documents";
import { normalizeGraphSnapshot, type GraphSnapshot } from "../../lib/graph";
import { KnowledgeGraphCanvas } from "./canvas";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

let graph: KnowledgeGraphCanvas | undefined;

function renderList(snapshot: GraphSnapshot): void {
  const list = element("graph-node-list");
  list.replaceChildren(
    ...snapshot.nodes.map((node) => {
      const link = document.createElement("a");
      link.href = `/articles/${encodeURIComponent(node.id)}/`;
      link.dataset.nodeId = node.id;
      link.textContent = node.title;
      link.addEventListener("focus", () => graph?.setHighlighted(node.id));
      link.addEventListener("pointerenter", () => graph?.setHighlighted(node.id));
      link.addEventListener("pointerleave", () => graph?.setHighlighted(""));
      return link;
    }),
  );
}

async function loadGraph(): Promise<void> {
  const state = element("graph-state");
  const retry = element<HTMLButtonElement>("graph-retry");
  retry.hidden = true;
  state.hidden = false;
  state.textContent = "正在梳理知识之间的连接…";
  try {
    const raw = await requestJSON<GraphSnapshot>("/api/graph?view=published&limit=300");
    const snapshot = normalizeGraphSnapshot(raw);
    element("graph-node-count").textContent = String(snapshot.totalNodes);
    element("graph-edge-count").textContent = String(snapshot.totalEdges);
    element("graph-truncated").hidden = !snapshot.truncated;
    element("graph-stage").dataset.layoutMode = matchMedia("(prefers-reduced-motion: reduce)").matches ? "static" : "force";
    if (!snapshot.nodes.length) {
      state.textContent = "还没有已发布的知识节点。发布第一篇文章后，它会从这里亮起。";
      element("graph-stage").classList.add("is-empty");
      renderList(snapshot);
      return;
    }
    element("graph-stage").dataset.loadState = "ready";
    state.hidden = true;
    renderList(snapshot);
    graph = new KnowledgeGraphCanvas(
      element<HTMLCanvasElement>("knowledge-graph-canvas"),
      element("graph-stage"),
      snapshot,
    );
  } catch {
    element("graph-stage").dataset.loadState = "error";
    state.textContent = "知识星图暂时无法读取。文章仍可照常浏览，稍后可以再试一次。";
    retry.hidden = false;
  }
}

element<HTMLInputElement>("graph-search").addEventListener("input", (event) => {
  const query = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
  let first = "";
  element("graph-node-list").querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
    const visible = !query || link.textContent?.toLocaleLowerCase().includes(query);
    link.hidden = !visible;
    if (visible && !first) first = link.dataset.nodeId || "";
  });
  graph?.setHighlighted(first);
});
element("graph-zoom-in").addEventListener("click", () => graph?.zoomBy(1.2));
element("graph-zoom-out").addEventListener("click", () => graph?.zoomBy(1 / 1.2));
element("graph-reset").addEventListener("click", () => graph?.resetView());
element("graph-retry").addEventListener("click", () => void loadGraph());
void loadGraph();
