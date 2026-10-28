import {
  boundedPosition,
  type WorkspaceInput,
  type WorkspacePosition,
  resolveWorkspaceDocuments,
} from "../../lib/workspaces";
import type { DocumentSummary } from "../../lib/documents";
import { element, get } from "./dom";

export function renderCanvas(
  state: WorkspaceInput,
  documents: DocumentSummary[],
  moved: (position: WorkspacePosition) => void,
) {
  const canvas = get("ws-canvas");
  canvas.replaceChildren();
  if (!state.documentIds.length) {
    canvas.append(
      element(
        "p",
        "ws-view-empty",
        "先在阅读路径里加入文档，让第一条连接从这里开始。",
      ),
    );
    return;
  }
  const width = 1100,
    height = Math.max(650, Math.ceil(state.documentIds.length / 4) * 150 + 80);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  canvas.append(svg);
  const coordinates = new Map<string, WorkspacePosition>();
  const nodes = new Map<string, HTMLButtonElement>();
  const clamp = (id: string, x: number, y: number) =>
    boundedPosition(
      id,
      Math.max(24, Math.min(width - 244, x)),
      Math.max(24, Math.min(height - 120, y)),
    );
  state.documentIds.forEach((id, index) => {
    const saved = state.positions.find((position) => position.id === id);
    coordinates.set(
      id,
      clamp(
        id,
        saved?.x ?? 35 + (index % 4) * 265,
        saved?.y ?? 45 + Math.floor(index / 4) * 150,
      ),
    );
  });
  function drawEdges() {
    svg.replaceChildren(
      ...state.documentIds.slice(1).map((id, index) => {
        const from = coordinates.get(state.documentIds[index])!,
          to = coordinates.get(id)!;
        const line = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        line.setAttribute("x1", String(from.x + 110));
        line.setAttribute("y1", String(from.y + 45));
        line.setAttribute("x2", String(to.x + 110));
        line.setAttribute("y2", String(to.y + 45));
        return line;
      }),
    );
  }
  function positionNode(position: WorkspacePosition) {
    coordinates.set(position.id, position);
    const node = nodes.get(position.id)!;
    node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    drawEdges();
    moved(position);
  }
  resolveWorkspaceDocuments(state.documentIds, documents).forEach(
    ({ id, document, availability }, index) => {
      const node = element("button", `ws-canvas-node is-${availability}`);
      node.type = "button";
      node.append(
        element("span", "ws-node-number", String(index + 1).padStart(2, "0")),
        element("strong", "", document?.title || "不可用的文档"),
        element(
          "small",
          "",
          availability === "draft"
            ? "草稿 · 尚未发布"
            : availability === "published"
              ? "已发布"
              : "不可用 · 引用保留",
        ),
      );
      node.setAttribute(
        "aria-label",
        `${document?.title || "不可用的文档"}，使用方向键移动`,
      );
      node.dataset.documentId = id;
      const position = coordinates.get(id)!;
      node.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      nodes.set(id, node);
      node.addEventListener("keydown", (event) => {
        const delta: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        if (!delta[event.key]) return;
        event.preventDefault();
        const [dx, dy] = delta[event.key],
          step = event.shiftKey ? 40 : 10,
          current = coordinates.get(id)!;
        positionNode(clamp(id, current.x + dx * step, current.y + dy * step));
      });
      let drag:
        | { pointer: number; x: number; y: number; start: WorkspacePosition }
        | undefined;
      node.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          start: coordinates.get(id)!,
        };
        node.setPointerCapture(event.pointerId);
        node.classList.add("is-dragging");
      });
      node.addEventListener("pointermove", (event) => {
        if (!drag || drag.pointer !== event.pointerId) return;
        positionNode(
          clamp(
            id,
            drag.start.x + event.clientX - drag.x,
            drag.start.y + event.clientY - drag.y,
          ),
        );
      });
      const release = () => {
        drag = undefined;
        node.classList.remove("is-dragging");
      };
      node.addEventListener("pointerup", release);
      node.addEventListener("pointercancel", release);
      node.addEventListener("lostpointercapture", release);
      canvas.append(node);
    },
  );
  drawEdges();
}
