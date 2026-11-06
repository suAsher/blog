import { ApiError } from "../../lib/documents";
import {
  inboxQuery,
  loadInbox,
  readInboxFilter,
  readInboxOffset,
  saveInboxViews,
  selectInboxIds,
  updateInboxStage,
  validateInboxView,
  type InboxData,
  type InboxFilter,
  type InboxStage,
  type InboxView,
  type InboxViewName,
} from "../../lib/inbox";
import { get } from "../workspaces/dom";
import {
  renderInboxDocuments,
  renderInboxFilters,
  renderInboxViews,
} from "./render";

let filter = readInboxFilter(new URLSearchParams(location.search));
let offset = readInboxOffset(new URLSearchParams(location.search));
let data: InboxData | undefined;
let selected: string[] = [];
let busy = false;
let conflicted = false;
let loaded = false;

function status(message: string) {
  get("inbox-status").textContent = message;
}

function syncControls() {
  const unavailable = busy || !loaded;
  document
    .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "#inbox-filter-form input, #inbox-filter-form select, #inbox-filter-form button, " +
        "#inbox-tabs button, #inbox-saved-views button, #inbox-view-form input",
    )
    .forEach((control) => {
      control.disabled = busy;
    });
  document
    .querySelectorAll<HTMLInputElement>("#inbox-results input")
    .forEach((control) => {
      control.disabled = unavailable;
    });
  const pageSelection = get<HTMLInputElement>("inbox-select-page");
  const count =
    data?.documents.filter((doc) => selected.includes(doc.id)).length || 0;
  pageSelection.checked = Boolean(count && count === data?.documents.length);
  pageSelection.indeterminate =
    count > 0 && count < (data?.documents.length || 0);
  pageSelection.disabled = unavailable || !data?.documents.length;
  get<HTMLButtonElement>("inbox-apply").disabled =
    unavailable || conflicted || !selected.length;
  get<HTMLButtonElement>("inbox-clear-selection").disabled =
    busy || !selected.length;
  get<HTMLButtonElement>("inbox-save-view").disabled =
    unavailable || conflicted;
  document
    .querySelectorAll<HTMLButtonElement>("[data-delete-view]")
    .forEach((control) => {
      control.disabled = unavailable || conflicted;
    });
  get<HTMLSelectElement>("inbox-stage").disabled = busy;
  get<HTMLButtonElement>("inbox-previous").disabled =
    unavailable || offset === 0;
  get<HTMLButtonElement>("inbox-next").disabled =
    unavailable || offset + 50 >= (data?.total || 0);
  get<HTMLButtonElement>("inbox-conflict-reload").disabled = busy;
  get<HTMLButtonElement>("inbox-retry").disabled = busy;
  get("inbox-selected-count").textContent = selected.length
    ? `已选择 ${selected.length} 篇（含其他页）`
    : "尚未选择资料";
  get("inbox-results").setAttribute("aria-busy", String(busy));
}

function updateURL() {
  const params = new URLSearchParams(inboxQuery(filter, offset));
  if (!offset) params.delete("offset");
  params.delete("limit");
  for (const [key, value] of [...params]) if (!value) params.delete(key);
  history.replaceState(null, "", `/inbox/?${params}`);
}

function render() {
  if (!data) return;
  renderInboxFilters(data, filter);
  renderInboxViews(
    data.views,
    (view) => {
      if (busy) return;
      filter = { ...view.filter };
      offset = 0;
      updateURL();
      void refresh();
    },
    (id) => {
      void deleteView(id);
    },
  );
  renderInboxDocuments(data.documents, selected, (id, checked) => {
    selected = selectInboxIds(selected, [id], checked);
    if (checked && !selected.includes(id)) {
      status("每次最多选择 100 篇，请先完成这一批整理。");
      render();
    }
    syncControls();
  });
  get("inbox-count").textContent = `${data.total} 篇资料`;
  get("inbox-empty").hidden = data.documents.length > 0;
  get("inbox-page-number").textContent = data.total
    ? `${Math.floor(offset / 50) + 1} / ${Math.ceil(data.total / 50)}`
    : "0 / 0";
  syncControls();
}

async function refresh(message = "") {
  if (busy) return;
  busy = true;
  loaded = false;
  get("inbox-retry").hidden = true;
  status("正在读取资料…");
  syncControls();
  try {
    data = await loadInbox(filter, offset);
    if (data.total > 0 && offset >= data.total) {
      offset = Math.floor((data.total - 1) / 50) * 50;
      data = await loadInbox(filter, offset);
    }
    conflicted = false;
    loaded = true;
    get("inbox-conflict-reload").hidden = true;
    updateURL();
    render();
    status(message || `已读取 ${data.total} 篇资料。整理记录随账号保存。`);
  } catch (error) {
    status(error instanceof Error ? error.message : "资料读取失败，请重试。");
    get("inbox-retry").hidden = false;
  } finally {
    busy = false;
    syncControls();
  }
}

function writeFailure(error: unknown) {
  conflicted = error instanceof ApiError && error.status === 409;
  get("inbox-conflict-reload").hidden = !conflicted;
  status(
    conflicted
      ? "其他页面已更新整理记录。所选资料与筛选仍保留；读取最新状态后，请检查并再次点击保存。"
      : `${error instanceof Error ? error.message : "保存未完成。"} 所选资料和筛选仍保留，可再次提交。`,
  );
}

async function saveStage() {
  if (busy || conflicted || !data || !loaded || !selected.length) return;
  busy = true;
  syncControls();
  status("正在保存整理进度…");
  try {
    await updateInboxStage(
      data.version,
      [...selected],
      get<HTMLSelectElement>("inbox-stage").value as InboxStage,
    );
    selected = [];
    busy = false;
    await refresh("整理进度已保存。正文和发布状态保持原样。");
  } catch (error) {
    writeFailure(error);
  } finally {
    busy = false;
    syncControls();
  }
}

async function persistViews(
  views: InboxView[],
  message: string,
  clearName = false,
) {
  if (busy || conflicted || !data || !loaded) return;
  busy = true;
  syncControls();
  status("正在保存筛选视图…");
  try {
    await saveInboxViews(data.version, views);
    if (clearName) get<HTMLInputElement>("inbox-view-name").value = "";
    busy = false;
    await refresh(message);
  } catch (error) {
    writeFailure(error);
  } finally {
    busy = false;
    syncControls();
  }
}

async function saveView() {
  if (!data) return;
  if (data.views.length >= 12) {
    status("最多保存 12 个筛选视图，请先删除不再使用的视图。");
    return;
  }
  const view: InboxView = {
    id: crypto.randomUUID(),
    name: get<HTMLInputElement>("inbox-view-name").value.trim(),
    filter: { ...filter },
  };
  const error = validateInboxView(view);
  if (error) {
    status(error);
    return;
  }
  await persistViews(
    [...data.views, view],
    "筛选视图已保存，可在其他设备继续使用。",
    true,
  );
}

async function deleteView(id: string) {
  if (!data) return;
  await persistViews(
    data.views.filter((view) => view.id !== id),
    "筛选视图已删除，资料继续保留。",
  );
}

function selectFilter(next: InboxFilter) {
  if (busy) return;
  filter = next;
  offset = 0;
  updateURL();
  void refresh();
}

get("inbox-filter-form").addEventListener("submit", (event) => {
  event.preventDefault();
  selectFilter({
    ...filter,
    q: get<HTMLInputElement>("inbox-search").value.trim(),
    tag: get<HTMLSelectElement>("inbox-tag").value,
    routeId: get<HTMLSelectElement>("inbox-route").value,
  });
});
document
  .querySelectorAll<HTMLButtonElement>("#inbox-tabs [data-view]")
  .forEach((tab) => {
    tab.addEventListener("click", () =>
      selectFilter({ ...filter, view: tab.dataset.view as InboxViewName }),
    );
  });
get("inbox-view-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void saveView();
});
get("inbox-apply").addEventListener("click", () => {
  void saveStage();
});
get("inbox-select-page").addEventListener("change", (event) => {
  const checked = (event.target as HTMLInputElement).checked;
  selected = selectInboxIds(
    selected,
    data?.documents.map((doc) => doc.id) || [],
    checked,
  );
  render();
  if (checked && data?.documents.some((doc) => !selected.includes(doc.id)))
    status("最多选择 100 篇，已保留先选中的资料。");
});
get("inbox-clear-selection").addEventListener("click", () => {
  selected = [];
  render();
});
get("inbox-clear-filter").addEventListener("click", () =>
  selectFilter({ view: "all", q: "", tag: "", routeId: "" }),
);
get("inbox-previous").addEventListener("click", () => {
  if (!busy) {
    offset = Math.max(0, offset - 50);
    void refresh();
  }
});
get("inbox-next").addEventListener("click", () => {
  if (!busy) {
    offset += 50;
    void refresh();
  }
});
get("inbox-retry").addEventListener("click", () => {
  void refresh();
});
get("inbox-conflict-reload").addEventListener("click", () => {
  void refresh("已读取最新状态，选择仍保留。请检查后再次提交。");
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void refresh();
});
get<HTMLInputElement>("inbox-search").value = filter.q;
void refresh();
