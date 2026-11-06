import {
  jsonRequest, requestJSON, type DocumentList, type DocumentSummary,
} from "../../lib/documents";
import {
  assignImportLesson, importRouteCandidates, moveImportItem,
  proposeImportRoute, routeInput, type ImportRouteDraft, type RouteImportReport,
} from "../../lib/import-route";
import type { LearningPath } from "../../lib/learning-paths";
import "../../styles/import-route.css";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
};
function action(text: string, click: () => void, label = text) {
  const button = node("button", text);
  button.type = "button";
  button.className = "button";
  button.setAttribute("aria-label", label);
  button.addEventListener("click", click);
  return button;
}
function field(label: string, input: HTMLElement) {
  const wrapper = node("label", label);
  wrapper.append(input);
  return wrapper;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "编排暂时没有完成，请重试。";

async function currentDocuments(report: RouteImportReport) {
  const candidates = importRouteCandidates(report);
  if (candidates.length > 300) throw new Error("本批超过 300 篇，请在路线页分批整理。");
  const remaining = new Set(candidates.map(item => item.id!));
  const result = new Map<string, DocumentSummary>();
  // Reuse the bounded metadata listing. Import arrangement never needs full bodies.
  for (let offset = 0; offset < 10000 && remaining.size; offset += 1000) {
    const page = await requestJSON<DocumentList>(`/api/documents?status=all&limit=1000&offset=${offset}`);
    for (const item of page.documents) {
      if (remaining.delete(item.id)) result.set(item.id, item);
    }
    if (offset + page.documents.length >= page.total || !page.documents.length)
      return [...result.values()];
  }
  if (remaining.size) throw new Error("文档目录超过本页核对预算，请在路线页手动编排。");
  return [...result.values()];
}

/** The saved report is the durable source of identity; no private draft is stored in the browser. */
export function appendImportRoute(area: HTMLElement, report: RouteImportReport) {
  if (!/^[a-f0-9]{32}$/.test(report.id) || !report.outcomes?.length) return;
  const section = node("section");
  section.className = "import-route";
  section.setAttribute("aria-label", "导入资料编排");
  section.setAttribute("aria-live", "off");
  const status = node("p");
  status.setAttribute("role", "status");
  const open = action("编排为学习路线", () => void load());
  open.classList.add("button-primary");
  section.append(node("span", "FROM FILES TO A LEARNING PATH"),
    node("h3", "让资料有一条阅读顺序"),
    node("p", "按原文件夹建议章节，你可以改名、合并归属和调整顺序。保存只创建目录，文档仍保留原发布状态。"),
    open, status);
  area.append(section);
  const creationKey = `import-${report.id}`;
  let draft: ImportRouteDraft | undefined;
  let form: HTMLFormElement | undefined;

  function done(route: LearningPath) {
    if (!section.isConnected) return;
    form?.remove();
    open.hidden = true;
    status.textContent = "这份报告已编排为路线。后续调整请进入路线页；不会重复创建或覆盖已有编排。";
    const link = node("a", `打开路线：${route.title} →`);
    link.className = "button button-primary";
    link.href = `/learn/?id=${encodeURIComponent(route.id)}`;
    section.append(link);
  }
  async function existing() {
    const { paths } = await requestJSON<{ paths: (LearningPath & {creationKey?: string})[] }>("/api/learning-paths");
    return paths.find(path => path.creationKey === creationKey);
  }
  async function load() {
    open.disabled = true;
    status.textContent = "正在核对导入收据与文档状态…";
    try {
      const prior = await existing();
      if (prior) { done(prior); return; }
      const documents = await currentDocuments(report);
      draft = proposeImportRoute(report, documents);
      if (!section.isConnected) return;
      if (!draft.lessons.length) {
        status.textContent = "没有可编排的文档：跳过项、缺图文档、已删除文档及无法核对的记录不会自动加入。可修复后重新导入，或到路线页手动整理。";
        return;
      }
      open.hidden = true;
      render();
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      open.disabled = false;
    }
  }
  function render(focusKey?: string) {
    if (!draft || !section.isConnected) return;
    form?.remove();
    form = node("form");
    form.className = "import-route-form";
    form.addEventListener("submit", event => { event.preventDefault(); void save(); });
    const title = node("input");
    title.value = draft.title;
    title.maxLength = 160;
    title.required = true;
    title.addEventListener("input", () => { draft = { ...draft!, title: title.value }; });
    const description = node("textarea");
    description.value = draft.description;
    description.maxLength = 4000;
    description.rows = 2;
    description.addEventListener("input", () => { draft = { ...draft!, description: description.value }; });
    form.append(field("新路线名称", title), field("路线说明（可选）", description));
    const chapters = node("div");
    chapters.className = "import-route-chapters";
    draft.chapters.forEach((chapter, index) => {
      const row = node("div");
      row.className = "import-route-chapter";
      const name = node("input");
      name.value = chapter.title;
      name.maxLength = 160;
      name.setAttribute("aria-label", `章节 ${index + 1} 名称`);
      name.addEventListener("input", () => {
        draft = { ...draft!, chapters: draft!.chapters.map(item => item.id === chapter.id ? { ...item, title: name.value } : item) };
        form?.querySelectorAll<HTMLOptionElement>("option").forEach(option => {
          if (option.value === chapter.id) option.textContent = name.value || "未命名章节";
        });
      });
      row.append(node("strong", String(index + 1).padStart(2, "0")), name);
      for (const [direction, text] of [[-1, "上移"], [1, "下移"]] as const) {
        const move = action(text, () => {
          const selected = draft!.chapters.find(item => item.id === chapter.id)!;
          draft = { ...draft!, chapters: moveImportItem(draft!.chapters, selected, direction) };
          render(`${chapter.id}-${direction}`);
        }, `章节 ${index + 1} ${text}`);
        move.disabled = index + direction < 0 || index + direction >= draft!.chapters.length;
        move.dataset.focusKey = `${chapter.id}-${direction}`;
        row.append(move);
      }
      chapters.append(row);
    });
    form.append(node("h4", "01 / 整理章节"), chapters, action("添加一个章节", () => {
      if (draft!.chapters.length >= 30) { status.textContent = "每条路线最多 30 章，可合并文档归属后保存。"; return; }
      draft = { ...draft!, chapters: [...draft!.chapters, {id: crypto.randomUUID(), title:"新章节"}] };
      render();
      const names = form?.querySelectorAll<HTMLInputElement>(".import-route-chapter input");
      names?.[names.length - 1]?.focus();
    }));
    form.append(node("h4", "02 / 安排文章"), node("p", "原路径只用于建议分类。选择同一章节可合并资料，选择「不加入」会保留文档但不加入本路线。空章不会保存。"));
    const lessons = node("div");
    lessons.className = "import-route-lessons";
    draft.lessons.forEach((lesson, index) => {
      const row = node("div");
      row.className = "import-route-lesson";
      row.dataset.routeDocument = lesson.id;
      const heading = node("div");
      heading.append(node("strong", lesson.title), node("code", lesson.path));
      const select = node("select");
      select.setAttribute("aria-label", `章节归属：${lesson.path}`);
      select.add(new Option("不加入本路线", ""));
      draft!.chapters.forEach(chapter => select.add(new Option(chapter.title || "未命名章节", chapter.id)));
      select.value = lesson.chapterId;
      select.addEventListener("change", () => { draft = assignImportLesson(draft!, lesson.id, select.value); });
      const moves = node("div");
      moves.className = "import-route-moves";
      for (const [direction, text] of [[-1,"上移"],[1,"下移"]] as const) {
        const move = action(text, () => {
          const selected = draft!.lessons.find(item => item.id === lesson.id)!;
          draft = { ...draft!, lessons: moveImportItem(draft!.lessons, selected, direction) };
          render(`${lesson.id}-${direction}`);
        }, `${lesson.title} ${text}`);
        move.disabled = index + direction < 0 || index + direction >= draft!.lessons.length;
        move.dataset.focusKey = `${lesson.id}-${direction}`;
        moves.append(move);
      }
      row.append(heading, select, moves);
      lessons.append(row);
    });
    const submit = node("button", "确认创建学习路线");
    submit.type = "submit";
    submit.className = "button button-primary";
    form.append(lessons, submit);
    status.textContent = `${draft.lessons.length} 篇可编排文档${draft.excluded ? `；${draft.excluded} 项因跳过、重复、缺图或不可用而排除` : ""}。关闭窗口后可从最近导入报告重新开始。`;
    section.append(form);
    if (focusKey) {
      const controls = [...form.querySelectorAll<HTMLButtonElement>("[data-focus-key]")];
      const target = controls.find(button => button.dataset.focusKey === focusKey);
      if (target && !target.disabled) target.focus();
      else (target?.parentElement?.querySelector<HTMLButtonElement>("button:not(:disabled)") || title).focus();
    }
  }
  async function save() {
    if (!draft || !form) return;
    let value;
    try { value = routeInput(draft); }
    catch (error) { status.textContent = errorText(error); return; }
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>("input, button, select, textarea")];
    const states = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    status.textContent = "正在保存路线，文档正文不会改变…";
    try {
      // Reopening a report or retrying a lost response must recover its existing route.
      const prior = await existing();
      if (prior) { done(prior); return; }
      const result = await requestJSON<LearningPath>("/api/learning-paths", jsonRequest("POST", value));
      done(result);
    } catch (error) {
      status.textContent = `${errorText(error)} 当前编排仍保留；重试会先检查是否已创建，不会覆盖其他路线。`;
    } finally {
      controls.forEach((control, index) => { control.disabled = states[index]; });
    }
  }
}
