import {
  graphTagColor,
  neighborIds,
  type GraphSnapshot,
} from "../../lib/graph";

interface PositionedNode {
  id: string;
  x: number;
  y: number;
}

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.55;
const MAX_SCALE = 2.5;

export class KnowledgeGraphCanvas {
  private context: CanvasRenderingContext2D;
  private worker: Worker;
  private positions = new Map<string, PositionedNode>();
  private view: ViewTransform = { x: 0, y: 0, scale: 1 };
  private hovered = "";
  private highlighted = "";
  private dragging = "";
  private moved = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPointer = { x: 0, y: 0 };
  private frame = 0;
  private visible = true;
  private converged = false;
  private reducedMotion = false;
  private pinchDistance = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private stage: HTMLElement,
    private snapshot: GraphSnapshot,
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    this.context = context;
    this.seedPositions();
    this.worker = new Worker(new URL("./force-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", (event) => {
      if (event.data?.type !== "positions") return;
      this.positions = new Map(
        (event.data.nodes as PositionedNode[]).map((node) => [node.id, node]),
      );
      this.converged = Boolean(event.data.done);
      this.stage.dataset.layoutReady = "true";
      this.stage.dataset.workerReady = "true";
      if (this.converged) this.stage.dataset.workerState = "converged";
      this.drawSoon();
    });
    this.worker.addEventListener("error", () => {
      this.stage.dataset.workerState = "error";
      this.stage.dataset.layoutReady = "true";
      this.drawSoon();
    });
    this.bindInteractions();
    this.observeLifecycle();
    this.resize(true);
  }

  private seedPositions(): void {
    const width = Math.max(240, this.canvas.clientWidth);
    const height = Math.max(320, this.canvas.clientHeight);
    const radiusLimit = Math.min(width, height) * 0.34;
    this.positions = new Map(
      this.snapshot.nodes.map((node, index) => {
        const angle = index * 2.399963229728653;
        const radius = Math.sqrt(index / Math.max(1, this.snapshot.nodes.length)) * radiusLimit;
        return [node.id, {
          id: node.id,
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius,
        }];
      }),
    );
    this.stage.dataset.layoutReady = "true";
  }

  setHighlighted(id: string): void {
    this.highlighted = id;
    this.drawSoon();
  }

  zoomBy(factor: number): void {
    this.zoomAt(factor, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  resetView(): void {
    this.view = { x: 0, y: 0, scale: 1 };
    this.drawSoon();
  }

  private resize(initial = false): void {
    const width = Math.max(240, this.canvas.clientWidth);
    const height = Math.max(320, this.canvas.clientHeight);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.stage.dataset.layoutMode = this.reducedMotion ? "static" : "force";
    if (initial)
      this.worker.postMessage({
        type: "init",
        nodes: this.snapshot.nodes,
        edges: this.snapshot.edges,
        width,
        height,
        reducedMotion: this.reducedMotion,
      });
    else this.worker.postMessage({ type: "resize", width, height });
    this.drawSoon();
  }

  private bindInteractions(): void {
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomAt(Math.exp(-event.deltaY * 0.0015), event.offsetX, event.offsetY);
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
      if (this.pointers.size === 2) {
        const points = [...this.pointers.values()];
        this.pinchDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      }
      this.lastPointer = { x: event.offsetX, y: event.offsetY };
      this.moved = false;
      this.dragging = this.nodeAt(event.offsetX, event.offsetY)?.id || "";
      if (this.dragging && !this.reducedMotion) {
        const point = this.toGraph(event.offsetX, event.offsetY);
        this.worker.postMessage({ type: "drag", id: this.dragging, ...point, active: true });
      }
    });
    this.canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.pointers.size) {
        this.hovered = "";
        this.drawSoon();
      }
    });
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) {
      this.hovered = this.nodeAt(event.offsetX, event.offsetY)?.id || "";
      this.canvas.style.cursor = this.hovered ? "pointer" : "grab";
      this.drawSoon();
      return;
    }
    const previous = this.pointers.get(event.pointerId)!;
    this.pointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
    if (Math.hypot(event.offsetX - this.lastPointer.x, event.offsetY - this.lastPointer.y) > 3)
      this.moved = true;
    if (this.pointers.size === 2) {
      const points = [...this.pointers.values()];
      const newDistance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (this.pinchDistance > 0) this.zoomBy(newDistance / this.pinchDistance);
      this.pinchDistance = newDistance;
    } else if (this.dragging && !this.reducedMotion) {
      const point = this.toGraph(event.offsetX, event.offsetY);
      this.worker.postMessage({ type: "drag", id: this.dragging, ...point, active: true });
    } else {
      this.view = {
        ...this.view,
        x: this.view.x + event.offsetX - previous.x,
        y: this.view.y + event.offsetY - previous.y,
      };
      this.drawSoon();
    }
  }

  private pointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.dragging) {
      if (!this.reducedMotion)
        this.worker.postMessage({ type: "drag", id: this.dragging, active: false });
      if (!this.moved) location.assign(`/articles/${encodeURIComponent(this.dragging)}/`);
    }
    this.dragging = "";
    if (this.pointers.size < 2) this.pinchDistance = 0;
  }

  private observeLifecycle(): void {
    const sync = () => {
      const paused = document.hidden || !this.visible || this.converged;
      this.stage.dataset.workerState = this.converged
        ? "converged"
        : paused
          ? "paused"
          : "running";
      this.worker.postMessage({ type: "pause", paused });
    };
    document.addEventListener("visibilitychange", sync);
    new IntersectionObserver((entries) => {
      this.visible = entries[0]?.isIntersecting ?? true;
      sync();
    }, { threshold: 0.05 }).observe(this.canvas);
  }

  private zoomAt(factor: number, x: number, y: number): void {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.view.scale * factor));
    const ratio = scale / this.view.scale;
    this.view = {
      scale,
      x: x - (x - this.view.x) * ratio,
      y: y - (y - this.view.y) * ratio,
    };
    this.drawSoon();
  }

  private toGraph(x: number, y: number): { x: number; y: number } {
    return {
      x: (x - this.view.x) / this.view.scale,
      y: (y - this.view.y) / this.view.scale,
    };
  }

  private nodeAt(x: number, y: number) {
    const point = this.toGraph(x, y);
    return [...this.snapshot.nodes].reverse().find((node) => {
      const position = this.positions.get(node.id);
      return position && Math.hypot(position.x - point.x, position.y - point.y) <= 14;
    });
  }

  private drawSoon(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const context = this.context;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(this.view.x, this.view.y);
    context.scale(this.view.scale, this.view.scale);
    const focus = this.hovered || this.highlighted;
    const neighbors = focus ? neighborIds(focus, this.snapshot.edges) : new Set<string>();
    const textColor = getComputedStyle(document.documentElement).getPropertyValue("--text");
    for (const edge of this.snapshot.edges) {
      const source = this.positions.get(edge.source);
      const target = this.positions.get(edge.target);
      if (!source || !target) continue;
      const connected = !focus || edge.source === focus || edge.target === focus;
      context.beginPath();
      context.moveTo(source.x, source.y);
      context.lineTo(target.x, target.y);
      context.strokeStyle = edge.kind === "wiki"
        ? `rgba(135, 211, 198, ${connected ? 0.46 : 0.08})`
        : `rgba(181, 159, 232, ${connected ? 0.34 : 0.06})`;
      context.lineWidth = connected ? 1.25 : 0.7;
      context.stroke();
    }
    for (const node of this.snapshot.nodes) {
      const position = this.positions.get(node.id);
      if (!position) continue;
      const emphasized = !focus || node.id === focus || neighbors.has(node.id);
      const radius = node.id === focus ? 10 : 7;
      const color = graphTagColor(node.tags);
      context.globalAlpha = emphasized ? 1 : 0.18;
      context.beginPath();
      context.arc(position.x, position.y, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.shadowColor = color;
      context.shadowBlur = focus && emphasized ? (node.id === focus ? 18 : 7) : 0;
      context.fill();
      context.shadowBlur = 0;
      if (node.id === focus || this.snapshot.nodes.length <= 40) {
        context.fillStyle = textColor;
        context.font = "11px system-ui, sans-serif";
        context.fillText(node.title.slice(0, 28), position.x + 13, position.y + 4);
      }
    }
    context.globalAlpha = 1;
    context.restore();
  }
}
