import { requestJSON, type DocumentList } from "../lib/documents";
import {
  parsePassageQuery,
  passageParams,
  passageHref,
  highlightSegments,
  type Passage,
  type PassageResults,
} from "../lib/passage-search";

const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const query = get<HTMLInputElement>("passage-query");
const tag = get<HTMLSelectElement>("passage-tag");
const path = get<HTMLSelectElement>("passage-path");
const results = get("passage-results");
const status = get("passage-status");
const initial = parsePassageQuery(location.search);
let state = initial.state;
let pending: AbortController | undefined;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let facetsPending = false;

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}
function selected(select: HTMLSelectElement, value: string) {
  if (value && ![...select.options].some((option) => option.value === value)) {
    const option = node("option", "", value);
    option.value = value;
    select.append(option);
  }
  select.value = value;
}
function restoreInputs() {
  query.value = state.q;
  selected(tag, state.tag);
  selected(path, state.pathId);
}
function cancel() {
  clearTimeout(timer);
  pending?.abort();
  generation++;
}
function showError(message: string) {
  get("passage-error").hidden = false;
  get("passage-error-message").textContent = message;
  get("passage-empty").hidden = true;
  status.textContent = "搜索未完成";
}
function syncURL(mode: "push" | "replace") {
  const params = passageParams(state).toString();
  const href = `/search/${params ? `?${params}` : ""}`;
  if (location.pathname + location.search !== href)
    history[mode === "push" ? "pushState" : "replaceState"](null, "", href);
}
function snippet(passage: Passage, query: string) {
  const block = node(
    "p",
    `passage-snippet${passage.kind === "code" ? " passage-snippet-code" : ""}`,
  );
  for (const segment of highlightSegments(passage.snippet, query)) {
    block.append(
      segment.match
        ? node("mark", "", segment.text)
        : document.createTextNode(segment.text),
    );
  }
  return block;
}
function renderPassage(passage: Passage, number: number) {
  const row = node("article", "passage-result");
  const meta = node("div", "passage-result-meta");
  const kind =
    { paragraph: "段落", code: "代码", list: "列表", table: "表格" }[
      passage.kind
    ] || "片段";
  meta.append(
    node("span", "passage-result-number", String(number).padStart(2, "0")),
    node("span", "passage-kind", kind),
  );
  if (passage.category)
    meta.append(node("span", "passage-category", passage.category));
  const title = node("h3");
  const href = passageHref(passage, state.q, state.pathId);
  if (!href) return null;
  const link = node("a", "passage-result-link", passage.title);
  link.href = href;
  title.append(link);
  const context = node(
    "p",
    "passage-context",
    passage.headings.length
      ? passage.headings.map((heading) => heading.text).join(" / ")
      : "正文开篇",
  );
  row.append(meta, title, context, snippet(passage, state.q));
  if (passage.paths.length) {
    const routes = node("div", "passage-routes");
    routes.setAttribute("aria-label", "所属路线与章节");
    for (const route of passage.paths) {
      const routeHref = passageHref(passage, state.q, route.pathId);
      if (!routeHref) continue;
      const routeLink = node(
        "a",
        "passage-route",
        `${route.pathTitle} / ${route.chapterTitle}`,
      );
      routeLink.href = routeHref;
      routes.append(routeLink);
    }
    if ((passage.pathCount || 0) > passage.paths.length)
      routes.append(
        node(
          "span",
          "",
          `另 ${passage.pathCount! - passage.paths.length} 处路线归属`,
        ),
      );
    row.append(routes);
  }
  const footer = node("div", "passage-result-footer");
  const tags = node(
    "span",
    "passage-result-tags",
    passage.tags.map((tag) => `#${tag}`).join("  "),
  );
  const hint = node("span", "passage-open-hint", "打开对应段落 ↗");
  hint.setAttribute("aria-hidden", "true");
  footer.append(tags, hint);
  row.append(footer);
  return row;
}
function clearResults() {
  results.replaceChildren();
  results.setAttribute("aria-busy", "false");
  get("passage-error").hidden = true;
  get("passage-budget").hidden = true;
  get("passage-pagination").hidden = true;
  get("passage-empty").hidden = true;
}
function showEmpty(hasQuery: boolean) {
  get("passage-empty").hidden = false;
  get("passage-empty-title").textContent = hasQuery
    ? "暂时没有匹配的段落"
    : "让一个关键词，带你回到上下文";
  get("passage-empty-description").textContent = hasQuery
    ? "试试更短的关键词，或清除标签与路线筛选。"
    : "搜索正文段落、代码、列表与表格；标签和路线帮你缩小范围。";
}
async function search(focusResults = false, invalid?: string) {
  cancel();
  clearResults();
  const validation = parsePassageQuery(`?${passageParams(state)}`);
  if (invalid || validation.error) {
    showError(invalid || validation.error!);
    return;
  }
  state = validation.state;
  if (!state.q) {
    showEmpty(false);
    status.textContent = "输入关键词，开始寻找。";
    return;
  }
  const token = generation;
  pending = new AbortController();
  results.setAttribute("aria-busy", "true");
  status.textContent = "正在检索已发布正文…";
  try {
    const data = await requestJSON<PassageResults>(
      `/api/search/passages?${passageParams(state)}`,
      { signal: pending.signal },
    );
    if (token !== generation) return;
    const rows = data.passages
      .map((item, index) => renderPassage(item, data.offset + index + 1))
      .filter((item): item is HTMLElement => Boolean(item));
    results.replaceChildren(...rows);
    status.textContent =
      data.total > 0
        ? `${data.truncated ? "已检索范围内" : "找到"} ${data.total} 个片段 · 当前 ${data.offset + (rows.length ? 1 : 0)}–${data.offset + rows.length}`
        : data.truncated
          ? "已检索范围内没有匹配"
          : "没有匹配的段落";
    if (!rows.length) showEmpty(true);
    const budget = get("passage-budget");
    budget.hidden = !data.truncated;
    budget.textContent =
      data.message ||
      "本次检索达到处理上限，结果可能不完整。请增加关键词或选择标签、路线缩小范围。";
    get("passage-pagination").hidden = data.offset === 0 && !data.hasMore;
    get<HTMLButtonElement>("passage-previous").disabled = data.offset === 0;
    get<HTMLButtonElement>("passage-next").disabled =
      !data.hasMore || data.offset + data.limit > 2000;
    get("passage-page-label").textContent =
      `第 ${Math.floor(data.offset / data.limit) + 1} 页`;
    if (focusResults)
      get("passage-results-heading").focus({ preventScroll: true });
  } catch (error) {
    if (
      token !== generation ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      return;
    showError(
      error instanceof Error
        ? error.message
        : "暂时无法搜索，请检查连接后重试。",
    );
  } finally {
    if (token === generation) results.setAttribute("aria-busy", "false");
  }
}
function fromInputs(mode: "push" | "replace", immediate = true) {
  cancel();
  state = {
    ...state,
    q: query.value.trim(),
    tag: tag.value,
    pathId: path.value,
    offset: 0,
    limit:
      Number.isInteger(state.limit) && state.limit >= 1 && state.limit <= 40
        ? state.limit
        : 12,
  };
  syncURL(mode);
  if (immediate) void search();
  else {
    clearResults();
    status.textContent = state.q ? "等待输入完成…" : "输入关键词，开始寻找。";
    timer = setTimeout(() => void search(), 300);
  }
}
async function loadFacets() {
  if (facetsPending) return;
  facetsPending = true;
  get("passage-facet-retry").hidden = true;
  const responses = await Promise.allSettled([
    requestJSON<DocumentList>("/api/documents?status=published&limit=1"),
    requestJSON<{ paths: { id: string; title: string }[] }>(
      "/api/learning-paths",
    ),
  ]);
  const [tags, paths] = responses;
  if (tags.status === "fulfilled") {
    tag.replaceChildren(node("option", "", "全部标签"));
    tag.options[0].value = "";
    for (const item of tags.value.tags) {
      const option = node("option", "", `${item.name} (${item.count})`);
      option.value = item.name;
      tag.append(option);
    }
    selected(tag, state.tag);
  }
  if (paths.status === "fulfilled") {
    path.replaceChildren(node("option", "", "全部路线"));
    path.options[0].value = "";
    for (const item of paths.value.paths) {
      const option = node("option", "", item.title);
      option.value = item.id;
      path.append(option);
    }
    selected(path, state.pathId);
  }
  const failed = responses.some((response) => response.status === "rejected");
  get("passage-facet-status").textContent = failed
    ? "部分筛选暂时无法读取，仍可搜索正文。"
    : "";
  get("passage-facet-retry").hidden = !failed;
  facetsPending = false;
}
get<HTMLFormElement>("passage-search-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    if (!composing) fromInputs("push");
  },
);
query.addEventListener("compositionstart", () => {
  composing = true;
  cancel();
});
query.addEventListener("compositionend", () => {
  composing = false;
  fromInputs("replace", false);
});
query.addEventListener("input", () => {
  if (!composing) fromInputs("replace", false);
});
for (const input of [tag, path])
  input.addEventListener("change", () => fromInputs("push"));
get("passage-reset").addEventListener("click", () => {
  query.value = "";
  tag.value = "";
  path.value = "";
  fromInputs("push");
  query.focus();
});
get("passage-retry").addEventListener("click", () => fromInputs("replace"));
get("passage-facet-retry").addEventListener("click", () => void loadFacets());
for (const [id, delta] of [
  ["passage-previous", -1],
  ["passage-next", 1],
] as const) {
  get(id).addEventListener("click", () => {
    state = {
      ...state,
      offset: Math.max(0, Math.min(2000, state.offset + delta * state.limit)),
    };
    syncURL("push");
    void search(true);
  });
}
window.addEventListener("popstate", () => {
  const restored = parsePassageQuery(location.search);
  state = restored.state;
  restoreInputs();
  void search(false, restored.error);
});
window.addEventListener("pagehide", cancel);
restoreInputs();
void search(false, initial.error);
void loadFacets();
