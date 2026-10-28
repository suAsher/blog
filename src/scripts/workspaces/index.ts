import {
  ApiError,
  jsonRequest,
  requestJSON,
  type DocumentList,
  type DocumentSummary,
} from "../../lib/documents";
import {
  emptyWorkspace,
  workspaceDocumentChoices,
  moveDocument,
  reapplyWorkspace,
  removeDocument,
  resolveWorkspaceDocuments,
  validateWorkspace,
  type Workspace,
  type WorkspaceInput,
} from "../../lib/workspaces";
import { button, element, get } from "./dom";
import { renderCanvas } from "./canvas";
import { renderComparison, setComparisonDocuments } from "./comparison";

let workspaces: Workspace[] = [];
let documents: DocumentSummary[] = [];
let current: Workspace | undefined;
let draft: WorkspaceInput = emptyWorkspace();
let dirty = false,
  busy = false,
  ready = false;
let view = "path";
const normal = (value: Workspace): Workspace => ({
  ...value,
  documentIds: value.documentIds || [],
  questions: value.questions || [],
  positions: value.positions || [],
});
const copy = (value: WorkspaceInput): WorkspaceInput => ({
  title: value.title,
  description: value.description,
  documentIds: [...value.documentIds],
  questions: value.questions.map((q) => ({ ...q })),
  positions: value.positions.map((p) => ({ ...p })),
});
const notice = (message: string, error = false) => {
  get("ws-status").textContent = message;
  get("ws-status").classList.toggle("is-error", error);
};
function changed() {
  dirty = true;
  get("ws-discard").hidden = false;
  notice("有尚未保存的修改。");
}
function setBusy(value: boolean) {
  busy = value;
  get("ws-editor").inert = value;
  get<HTMLButtonElement>("ws-new").disabled = value || !ready;
  get("ws-list")
    .querySelectorAll("button")
    .forEach((button) => (button.disabled = value));
}
function canSwitch() {
  if (busy) return false;
  if (dirty) {
    notice("请先保存主题，或点击「放弃本地修改」后再切换。", true);
    return false;
  }
  return true;
}
function renderList() {
  get("ws-count").textContent = String(workspaces.length);
  get("ws-list").replaceChildren(
    ...(workspaces.length
      ? workspaces.map((workspace) => {
          const item = button("", () => {
            if (canSwitch()) open(workspace);
          });
          item.className = "ws-topic";
          item.setAttribute(
            "aria-current",
            current?.id === workspace.id ? "true" : "false",
          );
          item.append(
            element("strong", "", workspace.title),
            element(
              "small",
              "",
              `${workspace.documentIds.length} 篇文档 · ${workspace.questions.filter((q) => q.done).length}/${workspace.questions.length} 个问题`,
            ),
          );
          return item;
        })
      : [
          element(
            "p",
            "ws-list-empty",
            "还没有主题。给一个一直好奇的问题，留个位置。",
          ),
        ]),
  );
}
function open(workspace?: Workspace) {
  current = workspace && normal(workspace);
  draft = current ? copy(current) : emptyWorkspace();
  dirty = false;
  get("ws-editor").hidden = false;
  get("ws-welcome").hidden = true;
  get<HTMLInputElement>("ws-title").value = draft.title;
  get<HTMLTextAreaElement>("ws-description").value = draft.description;
  get("ws-conflict").hidden = true;
  get("ws-delete-confirm").hidden = true;
  get("ws-delete").hidden = !current;
  get("ws-discard").hidden = true;
  const url = new URL(location.href);
  if (current) url.searchParams.set("id", current.id);
  else url.searchParams.delete("id");
  history.replaceState(null, "", url);
  renderList();
  renderContent();
  notice(
    current
      ? "已读取保存的主题。"
      : "给主题起个名字，再加入几篇值得一起读的文档。",
  );
}
function focusPathControl(
  id: string | undefined,
  preferred: "up" | "down" | "remove",
) {
  const row = get("ws-reading-path").querySelector<HTMLElement>(
    `[data-document-id="${id}"]`,
  );
  const control =
    row?.querySelector<HTMLButtonElement>(
      `[data-path-action="${preferred}"]:not(:disabled)`,
    ) || row?.querySelector<HTMLButtonElement>("button:not(:disabled)");
  if (control) control.focus();
  else get<HTMLInputElement>("ws-document-search").focus();
}
function renderPath() {
  get("ws-path-count").textContent = `${draft.documentIds.length} / 100`;
  const rows = resolveWorkspaceDocuments(draft.documentIds, documents);
  get("ws-reading-path").replaceChildren(
    ...(rows.length
      ? rows.map(({ id, document: doc, availability }, index) => {
          const row = element("li", "ws-path-item");
          row.dataset.documentId = id;
          row.append(
            element(
              "span",
              "ws-path-number",
              String(index + 1).padStart(2, "0"),
            ),
          );
          const text = element("div", "ws-path-copy");
          if (availability !== "unavailable" && doc) {
            const link = element("a", "", doc.title);
            link.href =
              availability === "draft"
                ? `/manage/?id=${encodeURIComponent(id)}`
                : `/articles/${encodeURIComponent(id)}/`;
            text.append(link);
          } else text.append(element("strong", "", "不可用的文档"));
          text.append(
            element(
              "small",
              `ws-badge is-${availability}`,
              availability === "draft"
                ? "草稿 · 在写作中打开，不参与正文对照"
                : availability === "published"
                  ? "已发布 · 阅读已发布版本"
                  : `不可用 · 引用保留 ${id.slice(0, 8)}`,
            ),
          );
          row.append(text);
          const controls = element("div", "ws-path-controls");
          const label = doc?.title || `不可用的文档 ${index + 1}`;
          const move = (direction: -1 | 1) => {
            draft = {
              ...draft,
              documentIds: moveDocument(draft.documentIds, id, direction),
            };
            changed();
            renderContent();
            focusPathControl(id, direction === -1 ? "up" : "down");
          };
          const up = button("↑", () => move(-1), `上移 ${label}`);
          up.dataset.pathAction = "up";
          up.disabled = index === 0;
          const down = button("↓", () => move(1), `下移 ${label}`);
          down.dataset.pathAction = "down";
          down.disabled = index === rows.length - 1;
          const remove = button(
            "移除",
            () => {
              draft = removeDocument(draft, id);
              changed();
              renderContent();
              focusPathControl(
                draft.documentIds[
                  Math.min(index, draft.documentIds.length - 1)
                ],
                "remove",
              );
            },
            `移除 ${label}`,
          );
          remove.dataset.pathAction = "remove";
          controls.append(up, down, remove);
          row.append(controls);
          return row;
        })
      : [
          element(
            "li",
            "ws-view-empty",
            "还没有阅读路径。从下面选一篇文章，开始这次探索。",
          ),
        ]),
  );
}
function renderPicker() {
  const query = get<HTMLInputElement>("ws-document-search")
    .value.trim()
    .toLocaleLowerCase();
  const available = documents.filter(
    (doc) =>
      doc.status !== "trash" &&
      !draft.documentIds.includes(doc.id) &&
      (!query || doc.title.toLocaleLowerCase().includes(query)),
  );
  get("ws-picker").replaceChildren(
    ...available.slice(0, 6).map((doc) => {
      const add = button(
        "",
        () => {
          if (draft.documentIds.length >= 100) {
            notice("一个主题最多加入 100 篇文档。", true);
            return;
          }
          draft = { ...draft, documentIds: [...draft.documentIds, doc.id] };
          changed();
          renderContent();
        },
        `加入 ${doc.title} ${doc.status === "draft" ? "草稿" : "已发布"}`,
      );
      add.className = "ws-picker-item";
      add.dataset.addDocument = doc.id;
      const plus = element("span", "", "＋");
      plus.setAttribute("aria-hidden", "true");
      add.append(
        element("span", "", doc.title),
        element(
          "small",
          `ws-badge is-${doc.status}`,
          doc.status === "draft" ? "草稿" : "已发布",
        ),
        plus,
      );
      return add;
    }),
  );
  if (!available.length)
    get("ws-picker").append(
      element(
        "p",
        "ws-picker-empty",
        query
          ? "没有匹配的可加入文档。"
          : "所有可用文档都已加入，或还没有文档。先到写作页创建一篇。",
      ),
    );
  else if (available.length > 6)
    get("ws-picker").append(
      element(
        "p",
        "ws-picker-empty",
        `显示前 6 篇，共 ${available.length} 篇。输入标题缩小范围。`,
      ),
    );
}
function renderQuestions() {
  get("ws-question-count").textContent =
    `${draft.questions.filter((q) => q.done).length} / ${draft.questions.length} 已完成`;
  get("ws-questions").replaceChildren(
    ...(draft.questions.length
      ? draft.questions.map((question, index) => {
          const row = element("li", "ws-question-item");
          const check = element("input");
          check.type = "checkbox";
          check.checked = question.done;
          check.setAttribute("aria-label", `完成 ${question.text}`);
          check.addEventListener("change", () => {
            draft = {
              ...draft,
              questions: draft.questions.map((q) =>
                q.id === question.id ? { ...q, done: check.checked } : q,
              ),
            };
            changed();
            get("ws-question-count").textContent =
              `${draft.questions.filter((q) => q.done).length} / ${draft.questions.length} 已完成`;
            row.classList.toggle("is-done", check.checked);
          });
          const text = element("input");
          text.type = "text";
          text.value = question.text;
          text.maxLength = 2000;
          text.setAttribute("aria-label", `问题 ${index + 1}`);
          text.addEventListener("input", () => {
            draft = {
              ...draft,
              questions: draft.questions.map((q) =>
                q.id === question.id ? { ...q, text: text.value } : q,
              ),
            };
            check.setAttribute("aria-label", `完成 ${text.value}`);
            changed();
          });
          row.classList.toggle("is-done", question.done);
          row.append(
            check,
            text,
            button(
              "×",
              () => {
                draft = {
                  ...draft,
                  questions: draft.questions.filter(
                    (q) => q.id !== question.id,
                  ),
                };
                changed();
                renderQuestions();
              },
              `移除问题 ${index + 1}`,
            ),
          );
          return row;
        })
      : [
          element(
            "li",
            "ws-question-empty",
            "还没有待探索的问题。把阅读时的疑惑记下来。",
          ),
        ]),
  );
}
function renderContent() {
  renderPath();
  renderPicker();
  renderQuestions();
  setComparisonDocuments(
    resolveWorkspaceDocuments(draft.documentIds, documents).flatMap((ref) =>
      ref.document ? [ref.document] : [],
    ),
  );
  if (view === "compare") void renderComparison();
  if (view === "canvas")
    renderCanvas(draft, documents, (position) => {
      draft = {
        ...draft,
        positions: [
          ...draft.positions.filter((p) => p.id !== position.id),
          position,
        ],
      };
      changed();
    });
}
function setView(next: string) {
  view = next;
  document
    .querySelectorAll<HTMLButtonElement>("[data-ws-view]")
    .forEach((tab) => {
      const active = tab.dataset.wsView === view;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      get(`ws-view-${tab.dataset.wsView}`).hidden = !active;
    });
  renderContent();
}
async function save() {
  if (busy) return;
  const issue = validateWorkspace(draft);
  if (issue) {
    notice(issue, true);
    return;
  }
  setBusy(true);
  notice("正在保存主题…");
  try {
    const saved = normal(
      await requestJSON<Workspace>(
        current ? `/api/workspaces/${current.id}` : "/api/workspaces",
        jsonRequest(current ? "PUT" : "POST", {
          ...copy(draft),
          ...(current ? { version: current.version } : {}),
        }),
      ),
    );
    workspaces = [saved, ...workspaces.filter((w) => w.id !== saved.id)];
    open(saved);
    notice("主题已保存，阅读路径与问题已同步。");
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      get("ws-conflict").hidden = false;
      notice("保存遇到版本冲突。你的本地修改已保留，请选择如何处理。", true);
    } else
      notice(
        error instanceof Error
          ? error.message
          : "主题暂时无法保存，编辑仍保留在页面中。",
        true,
      );
  } finally {
    setBusy(false);
  }
}
async function recover(reapply: boolean) {
  if (!current || busy) return;
  setBusy(true);
  try {
    const latest = normal(
      await requestJSON<Workspace>(`/api/workspaces/${current.id}`),
    );
    if (reapply) {
      draft = copy(reapplyWorkspace(draft, latest));
      current = latest;
      get("ws-conflict").hidden = true;
      setBusy(false);
      await save();
    } else {
      workspaces = workspaces.map((w) => (w.id === latest.id ? latest : w));
      open(latest);
      notice("已放弃本地编辑，并读取最新版本。");
    }
  } catch (error) {
    notice(
      error instanceof Error
        ? error.message
        : "无法读取最新主题，本地编辑仍保留。",
      true,
    );
  } finally {
    setBusy(false);
  }
}
async function deleteCurrent() {
  if (!current || busy) return;
  setBusy(true);
  try {
    await requestJSON(
      `/api/workspaces/${current.id}`,
      jsonRequest("DELETE", { version: current.version }),
    );
    workspaces = workspaces.filter((w) => w.id !== current!.id);
    current = undefined;
    dirty = false;
    get("ws-editor").hidden = true;
    get("ws-welcome").hidden = false;
    history.replaceState(null, "", "/workspaces/");
    renderList();
    notice("主题已删除。文档仍保留在知识空间。");
  } catch (error) {
    get("ws-delete-confirm").hidden = true;
    if (error instanceof ApiError && error.status === 409) {
      get("ws-conflict").hidden = false;
      notice("主题已在另一处更新。删除未执行，请先读取最新版本。", true);
    } else
      notice(
        error instanceof Error ? error.message : "删除暂时没有完成。",
        true,
      );
  } finally {
    setBusy(false);
  }
}
async function load() {
  ready = false;
  setBusy(true);
  get("ws-retry").hidden = true;
  notice("正在读取主题与文档…");
  try {
    const [result, docs] = await Promise.all([
      requestJSON<{ workspaces: Workspace[] }>("/api/workspaces"),
      loadDocuments(),
    ]);
    workspaces = result.workspaces.map(normal);
    documents = docs;
    ready = true;
    renderList();
    const wanted = new URL(location.href).searchParams.get("id");
    const selected = wanted
      ? workspaces.find((w) => w.id === wanted)
      : workspaces[0];
    if (selected) open(selected);
    else {
      get("ws-welcome").hidden = false;
      notice(
        wanted
          ? "这个主题当前不可用。可以从左侧选择其他主题。"
          : "空间准备好了。从一个问题，开始一个主题。",
      );
    }
  } catch (error) {
    notice(
      error instanceof Error ? error.message : "主题暂时无法读取，请稍后再试。",
      true,
    );
    get("ws-retry").hidden = false;
  } finally {
    setBusy(false);
  }
}
async function loadDocuments(): Promise<DocumentSummary[]> {
  const [live, published] = await Promise.all([
    loadDocumentStatus("all"),
    loadDocumentStatus("published"),
  ]);
  return workspaceDocumentChoices(live, published);
}
async function loadDocumentStatus(
  status: "all" | "published",
): Promise<DocumentSummary[]> {
  const result: DocumentSummary[] = [];
  for (let offset = 0; ;) {
    const page = await requestJSON<DocumentList>(
      `/api/documents?status=${status}&limit=1000&offset=${offset}`,
    );
    result.push(...page.documents);
    offset += page.documents.length;
    if (!page.documents.length || offset >= page.total) return result;
  }
}
get("ws-new").addEventListener("click", () => {
  if (ready && canSwitch()) {
    open();
    get<HTMLInputElement>("ws-title").focus();
  }
});
get("ws-retry").addEventListener("click", () => void load());
get("ws-save").addEventListener("click", () => void save());
get("ws-discard").addEventListener("click", () => {
  if (!busy) open(current);
});
get("ws-title").addEventListener("input", () => {
  draft = { ...draft, title: get<HTMLInputElement>("ws-title").value };
  changed();
});
get("ws-description").addEventListener("input", () => {
  draft = {
    ...draft,
    description: get<HTMLTextAreaElement>("ws-description").value,
  };
  changed();
});
get("ws-document-search").addEventListener("input", renderPicker);
get("ws-question-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = get<HTMLInputElement>("ws-question"),
    text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  if (draft.questions.length >= 50) {
    notice("一个主题最多保存 50 个问题。", true);
    return;
  }
  draft = {
    ...draft,
    questions: [
      ...draft.questions,
      { id: crypto.randomUUID(), text, done: false },
    ],
  };
  input.value = "";
  changed();
  renderQuestions();
});
get("ws-reload").addEventListener("click", () => void recover(false));
get("ws-reapply").addEventListener("click", () => void recover(true));
get("ws-delete").addEventListener("click", () => {
  get("ws-delete-confirm").hidden = false;
});
get("ws-delete-no").addEventListener("click", () => {
  get("ws-delete-confirm").hidden = true;
});
get("ws-delete-yes").addEventListener("click", () => void deleteCurrent());
const tabs = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-ws-view]"),
];
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => setView(tab.dataset.wsView!));
  tab.addEventListener("keydown", (event) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setView(tabs[next].dataset.wsView!);
    tabs[next].focus();
  });
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
  }
});
void load();
