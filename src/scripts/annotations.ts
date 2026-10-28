import {
  ApiError,
  jsonRequest,
  requestJSON,
  type DocumentDetail,
} from "../lib/documents";
import {
  annotationNoteContent,
  createQuoteResolver,
  createQuoteSelector,
  type Annotation,
  type QuoteSelector,
} from "../lib/annotations";
import { shanghaiToday } from "../lib/quick-note";

type TextSlice = { node: Text; start: number; end: number };
type HighlightAPI = { highlights: Map<string, unknown> };
let dispose: (() => void) | undefined;
const highlightNames = [
  "annotation-mint",
  "annotation-violet",
  "annotation-amber",
  "annotation-current",
];
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}
function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(value) {
      return value.parentElement?.closest(
        'button,script,style,[hidden],[aria-hidden="true"]',
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  for (let value = walker.nextNode(); value; value = walker.nextNode())
    nodes.push(value as Text);
  return nodes;
}
function projection(article: HTMLElement) {
  let source = "";
  const slices: TextSlice[] = textNodes(article).map((value) => {
    const start = source.length;
    source += value.data;
    return { node: value, start, end: source.length };
  });
  return { source, slices };
}
function sourceOffset(article: HTMLElement, container: Node, offset: number) {
  const before = document.createRange();
  before.selectNodeContents(article);
  before.setEnd(container, offset);
  return textNodes(before.cloneContents()).reduce(
    (sum, value) => sum + value.data.length,
    0,
  );
}
function sourceRange(
  slices: TextSlice[],
  start: number,
  end: number,
): Range | undefined {
  const first = slices.find((value) => value.end > start),
    last = slices.find((value) => value.end >= end && value.start < end);
  if (!first || !last) return;
  const range = document.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}
function highlight(name: string, ranges: Range[]) {
  const css = globalThis.CSS as typeof CSS & Partial<HighlightAPI>;
  const constructor = (
    globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
    }
  ).Highlight;
  if (css?.highlights && constructor)
    css.highlights.set(name, new constructor(...ranges));
}
function clearHighlights() {
  const css = globalThis.CSS as typeof CSS & Partial<HighlightAPI>;
  highlightNames.forEach((name) => css?.highlights?.delete(name));
}

/** Called only after a live, published document has been rendered. */
export function initAnnotations(
  documentId: string,
  _publishedVersion?: number,
) {
  dispose?.();
  const section = document.getElementById("annotations");
  const articleNode = document.getElementById("article-body");
  if (!section || !articleNode || !/^[a-f0-9]{32}$/.test(documentId)) return;
  const article: HTMLElement = articleNode;
  const controller = new AbortController(),
    signal = controller.signal;
  const capture = document.getElementById(
    "annotation-capture",
  ) as HTMLButtonElement;
  const reload = document.getElementById(
    "annotation-reload",
  ) as HTMLButtonElement;
  const status = document.getElementById("annotation-status")!;
  const form = document.getElementById("annotation-editor") as HTMLFormElement;
  const body = document.getElementById(
    "annotation-body",
  ) as HTMLTextAreaElement;
  const color = document.getElementById(
    "annotation-color",
  ) as HTMLSelectElement;
  const quoteView = document.getElementById("annotation-selected-quote")!;
  const save = document.getElementById("annotation-save") as HTMLButtonElement;
  const list = document.getElementById("annotation-list")!;
  let annotations: Annotation[] = [],
    selected: QuoteSelector | null = null;
  let editing: Annotation | undefined,
    activeQuote: QuoteSelector | null = null,
    busy = false;
  let editingMissing = false;
  let mutationGeneration = 0;
  let loadGeneration = 0;
  let loaded = false;
  let { source, slices } = projection(article);
  let resolve = createQuoteResolver(source);
  const refreshProjection = () => {
    const next = projection(article);
    if (next.source !== source) resolve = createQuoteResolver(next.source);
    ({ source, slices } = next);
  };
  section.hidden = false;
  function message(text: string, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function setBusy(value: boolean) {
    busy = value;
    form
      .querySelectorAll<
        | HTMLInputElement
        | HTMLButtonElement
        | HTMLTextAreaElement
        | HTMLSelectElement
      >("input,button,textarea,select")
      .forEach((control) => {
        control.disabled = value;
      });
    save.disabled = value || editingMissing;
    capture.disabled = value || !selected;
    reload.disabled = value;
  }
  function report(error: unknown) {
    const conflict = error instanceof ApiError && error.status === 409;
    message(
      conflict
        ? "批注版本冲突：另一处已经修改。当前输入已保留；请重新读取后检查并重试。"
        : `${error instanceof Error ? error.message : "操作没有完成。"} 当前输入已保留。`,
      true,
    );
    reload.hidden = false;
  }
  function begin(quote: QuoteSelector, annotation?: Annotation) {
    if (busy) return;
    if (!form.hidden && body.value !== (editing?.body || "")) {
      message("当前还有未保存的批注，请先保存或取消编辑，再选择另一段。", true);
      return;
    }
    editingMissing = false;
    save.disabled = false;
    activeQuote = quote;
    editing = annotation;
    quoteView.textContent = quote.exact;
    body.value = annotation?.body || "";
    color.value = annotation?.color || "mint";
    save.textContent = annotation ? "保存修改" : "保存批注";
    form.hidden = false;
    body.focus();
    form.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  function cancel() {
    if (busy) return;
    form.hidden = true;
    activeQuote = null;
    editing = undefined;
    editingMissing = false;
    save.disabled = false;
    body.value = "";
    capture.focus();
  }
  function jump(annotation: Annotation) {
    refreshProjection();
    const found = resolve(annotation.quote);
    if (found.state !== "matched") return;
    const range = sourceRange(slices, found.start, found.end);
    if (!range) return;
    highlight("annotation-current", [range]);
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ block: "center", behavior: "instant" });
    article.tabIndex = -1;
    article.focus({ preventScroll: true });
    history.replaceState(null, "", `#annotation-${annotation.id}`);
    message("已定位原文；批注列表保留在正文下方。");
  }
  async function convert(
    annotation: Annotation,
    control: HTMLButtonElement,
    row: HTMLElement,
  ) {
    control.disabled = true;
    try {
      const content = annotationNoteContent(
        annotation,
        document.getElementById("live-title")?.textContent || "阅读摘录",
        shanghaiToday(),
      );
      const note = await requestJSON<DocumentDetail>("/api/documents", {
        ...jsonRequest("POST", content),
        signal,
      });
      if (signal.aborted) return;
      const link = node("a", "打开笔记草稿", "annotation-note-link");
      link.href = `/manage/?id=${encodeURIComponent(note.id)}`;
      row.append(link);
      control.hidden = true;
      message("摘录已保存为新的笔记草稿。");
    } catch (error) {
      if (!signal.aborted) report(error);
    } finally {
      control.disabled = false;
    }
  }
  async function remove(annotation: Annotation, control: HTMLButtonElement) {
    if (control.dataset.confirm !== "true") {
      control.dataset.confirm = "true";
      control.textContent = "确认删除批注";
      return;
    }
    control.disabled = true;
    ++mutationGeneration;
    try {
      await requestJSON(`/api/annotations/${annotation.id}`, {
        ...jsonRequest("DELETE", { version: annotation.version }),
        signal,
      });
      if (signal.aborted) return;
      ++mutationGeneration;
      annotations = annotations.filter((item) => item.id !== annotation.id);
      render();
      message("批注已删除。");
      if (!loaded) void load();
    } catch (error) {
      if (!signal.aborted) report(error);
    } finally {
      control.disabled = false;
    }
  }
  function render() {
    refreshProjection();
    clearHighlights();
    const ranges: Record<Annotation["color"], Range[]> = {
      mint: [],
      violet: [],
      amber: [],
    };
    list.replaceChildren(
      ...annotations.map((annotation) => {
        const found = resolve(annotation.quote);
        if (found.state === "matched") {
          const range = sourceRange(slices, found.start, found.end);
          if (range) ranges[annotation.color]?.push(range);
        }
        const row = node("li", "", "annotation-card");
        row.id = `annotation-${annotation.id}`;
        row.dataset.color = annotation.color;
        row.append(
          node("blockquote", annotation.quote.exact, "annotation-quote"),
          node("p", annotation.body, "annotation-thought"),
        );
        const state =
          found.state === "matched"
            ? "已定位原文"
            : found.state === "ambiguous"
              ? "原文有多个匹配，暂不定位"
              : found.state === "stale"
                ? "上下文已变化，暂不定位"
                : "原文已改写或移除，保留最初摘录";
        row.append(node("p", state, "annotation-anchor-state"));
        const actions = node("div", "", "annotation-actions");
        const locate = node("button", "定位原文");
        locate.type = "button";
        locate.disabled = found.state !== "matched";
        locate.addEventListener("click", () => jump(annotation));
        const edit = node("button", "编辑批注");
        edit.type = "button";
        edit.addEventListener("click", () =>
          begin(annotation.quote, annotation),
        );
        const excerpt = node("button", "摘录为新笔记");
        excerpt.type = "button";
        excerpt.addEventListener("click", () => {
          void convert(annotation, excerpt, row);
        });
        const deletion = node("button", "删除批注");
        deletion.type = "button";
        deletion.addEventListener("click", () => {
          void remove(annotation, deletion);
        });
        actions.append(locate, edit, excerpt, deletion);
        row.append(actions);
        return row;
      }),
    );
    for (const name of ["mint", "violet", "amber"] as const)
      highlight(`annotation-${name}`, ranges[name]);
  }
  async function load() {
    const request = ++loadGeneration;
    const generation = mutationGeneration;
    reload.disabled = true;
    message("正在读取段落批注…");
    try {
      const data = await requestJSON<{ annotations: Annotation[] }>(
        `/api/annotations?documentId=${documentId}`,
        { signal },
      );
      if (
        signal.aborted ||
        request !== loadGeneration ||
        generation !== mutationGeneration
      )
        return;
      loaded = true;
      annotations = data.annotations;
      render();
      reload.hidden = true;
      if (editing) {
        const latest = annotations.find((item) => item.id === editing?.id);
        if (latest) {
          editing = latest;
          editingMissing = false;
          save.disabled = busy;
          message("已读取最新版本，当前输入已保留；检查后可重试保存。");
        } else {
          editingMissing = true;
          message(
            "当前编辑的批注已被删除。输入仍保留，可复制后取消编辑。",
            true,
          );
          save.disabled = true;
        }
      } else
        message(
          annotations.length
            ? `${annotations.length} 条批注 · 选中正文可继续记录。`
            : "选中正文，留下一条批注。批注保存到私有服务。",
        );
      const hashId = /^#annotation-([a-f0-9]{32})$/.exec(location.hash)?.[1];
      if (hashId)
        document
          .getElementById(`annotation-${hashId}`)
          ?.scrollIntoView({ block: "center" });
    } catch (error) {
      if (
        !signal.aborted &&
        request === loadGeneration &&
        generation === mutationGeneration
      ) {
        message("批注暂时无法读取。正文可继续阅读，编辑中的文字会保留。", true);
        reload.hidden = false;
      }
    } finally {
      if (request === loadGeneration) reload.disabled = busy;
    }
  }
  function selectionChanged() {
    if (busy || !form.hidden) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (
      !article.contains(range.startContainer) ||
      !article.contains(range.endContainer)
    )
      return;
    refreshProjection();
    const quote = createQuoteSelector(
      source,
      sourceOffset(article, range.startContainer, range.startOffset),
      sourceOffset(article, range.endContainer, range.endOffset),
    );
    selected = quote;
    capture.disabled = !quote;
    capture.dataset.ready = String(Boolean(quote));
    if (!quote) message("请选择 1–2000 字的正文。", true);
  }
  form.addEventListener(
    "submit",
    async (event) => {
      event.preventDefault();
      if (busy || editingMissing || !activeQuote) return;
      if (Array.from(body.value).length > 8000) {
        message("批注最多 8000 字，当前文字尚未保存。", true);
        return;
      }
      setBusy(true);
      ++mutationGeneration;
      const previous = editing;
      try {
        const data = previous
          ? { version: previous.version, body: body.value, color: color.value }
          : {
              documentId,
              quote: activeQuote,
              body: body.value,
              color: color.value,
            };
        const annotation = await requestJSON<Annotation>(
          previous ? `/api/annotations/${previous.id}` : "/api/annotations",
          { ...jsonRequest(previous ? "PUT" : "POST", data), signal },
        );
        if (signal.aborted) return;
        ++mutationGeneration;
        annotations = previous
          ? annotations.map((item) =>
              item.id === previous.id ? annotation : item,
            )
          : [...annotations, annotation];
        form.hidden = true;
        editing = undefined;
        editingMissing = false;
        activeQuote = null;
        body.value = "";
        selected = null;
        capture.dataset.ready = "false";
        render();
        message("批注已保存到私有服务。");
        document
          .getElementById(`annotation-${annotation.id}`)
          ?.scrollIntoView({ block: "nearest" });
        if (!loaded) void load();
      } catch (error) {
        if (!signal.aborted) report(error);
      } finally {
        setBusy(false);
      }
    },
    { signal },
  );
  capture.addEventListener(
    "click",
    () => {
      if (selected) begin(selected);
    },
    { signal },
  );
  document
    .getElementById("annotation-cancel")
    ?.addEventListener("click", cancel, { signal });
  document.addEventListener("selectionchange", selectionChanged, { signal });
  reload.addEventListener(
    "click",
    () => {
      void load();
    },
    { signal },
  );
  const cleanup = () => {
    controller.abort();
    clearHighlights();
    section.hidden = true;
    dispose = undefined;
  };
  document.addEventListener("astro:before-swap", cleanup, {
    once: true,
    signal,
  });
  document.addEventListener("auth:clear", cleanup, { once: true, signal });
  dispose = cleanup;
  void load();
  return cleanup;
}
