import { requestJSON, type DocumentSummary } from "../lib/documents";
import {
  activityCalendar,
  continuingDocuments,
  dailyDocumentHref,
  isLatestDashboardRequest,
  type Dashboard,
} from "../lib/daily";
import {
  retainedDraftAfterSave,
  saveQuickNote,
  TODAY_NOTE_DRAFT_KEY,
} from "../lib/quick-note";
import { articleUrl, element, getState, loadLibraryIndex } from "./shared";

const form = document.querySelector<HTMLFormElement>("#today-capture");
const note = document.querySelector<HTMLTextAreaElement>("#today-note");
const status = document.querySelector<HTMLElement>("#today-capture-status");
const panel = document.querySelector<HTMLElement>("#today-dashboard");
const below = document.querySelector<HTMLElement>("#today-below");
let dashboardVersion = 0;

try {
  if (note) note.value = sessionStorage.getItem(TODAY_NOTE_DRAFT_KEY) || "";
} catch {
  /* The form stays usable without tab storage. */
}
function persistDraft() {
  if (!note) return;
  try {
    if (note.value) sessionStorage.setItem(TODAY_NOTE_DRAFT_KEY, note.value);
    else sessionStorage.removeItem(TODAY_NOTE_DRAFT_KEY);
  } catch {
    if (status) status.textContent = "浏览器无法临时备份内容，请保持本页打开。";
  }
}
function documentLink(doc: DocumentSummary, prefix = "", edit = false) {
  const link = element("a", "today-document-link");
  link.href = edit
    ? `/manage/?id=${encodeURIComponent(doc.id)}`
    : dailyDocumentHref(doc);
  link.append(
    element("strong", "", doc.title),
    element(
      "small",
      "",
      `${prefix}${doc.status === "draft" ? "草稿" : "已发布"} · ${doc.date}`,
    ),
  );
  return link;
}
function section(
  title: string,
  docs: DocumentSummary[],
  empty: string,
  edit = false,
) {
  const container = element("section", "today-list");
  container.append(element("h3", "", title));
  if (!docs.length) container.append(element("p", "", empty));
  else
    container.append(
      ...docs.slice(0, 6).map((doc) => documentLink(doc, "", edit)),
    );
  return container;
}
function renderDashboard(data: Dashboard) {
  if (!panel || !below) return;
  const head = element("div", "today-card-heading");
  head.append(element("h3", "", "今日概览"), element("span", "", data.today));
  const stats = element("div", "today-stat-grid");
  for (const [value, label] of [
    [data.stats.draft, "篇草稿"],
    [data.stats.published, "篇已发布"],
    [data.streak.current, "天连续记录"],
  ] as const) {
    const item = element("div");
    item.append(
      element("strong", "", String(value)),
      element("span", "", label),
    );
    stats.append(item);
  }
  panel.replaceChildren(head, stats);
  const review = element("div", "today-review");
  review.append(element("span", "eyebrow", "REDISCOVER AN IDEA"));
  const anniversary = data.review.onThisDay[0];
  const selected = anniversary || data.review.random;
  if (selected) {
    review.append(
      element(
        "p",
        "",
        anniversary ? "往年的今天，你写过：" : "翻开一篇旧文章：",
      ),
    );
    const link = element("a", "quiet-link mint", `${selected.title} ↗`);
    link.href = dailyDocumentHref(selected);
    review.append(link);
    const another = element("button", "today-random", "再看一篇");
    another.type = "button";
    another.addEventListener("click", () => void loadDashboard());
    review.append(another);
  } else
    review.append(
      element("p", "", "发布文章后，这里会帮你重新遇见过去的想法。"),
    );
  panel.append(review);

  const map = document.querySelector<HTMLElement>("#today-heatmap");
  const cells = activityCalendar(
    data.today,
    data.activity,
    data.activitySince,
    366,
  );
  map?.replaceChildren(
    ...cells.map((day) => {
      const cell = element(
        "span",
        `today-day ${day.known ? "is-known" : "is-unknown"}`,
      );
      cell.dataset.level = String(Math.min(4, day.count));
      cell.title = day.known
        ? `${day.date} · ${day.count} 篇有内容的记录`
        : `${day.date} · 暂无完整历史记录`;
      cell.setAttribute("role", "listitem");
      cell.setAttribute("aria-label", cell.title);
      return cell;
    }),
  );
  map?.setAttribute(
    "aria-label",
    `过去 366 天写作活动；${data.streak.current} 天连续记录。虚线表示未知历史。`,
  );
  const streak = document.querySelector<HTMLElement>("#today-streak");
  if (streak)
    streak.textContent = `当前 ${data.streak.current} 天 · 最长 ${data.streak.longest} 天`;
  const history = document.querySelector<HTMLElement>("#today-history-note");
  if (history)
    history.textContent = data.historyComplete
      ? "每格代表当天有内容的文档数。"
      : "虚线表示尚未记录的历史；空格不代表那天没有写作。";
  const lists = document.querySelector<HTMLElement>("#today-lists");
  lists?.replaceChildren(
    section(
      "最近编辑",
      data.recent,
      "还没有文档。写下第一条，新的想法就会出现在这里。",
      true,
    ),
    section("草稿待续", data.drafts, "目前没有待续的草稿。", true),
  );
  const reading = element("section", "today-list");
  reading.append(element("h3", "", "继续阅读"));
  const state = getState();
  if (!Object.values(state).some((item) => item.progress > 0 && !item.read))
    reading.append(
      element("p", "", "阅读一篇文章后，未读完的内容会留在这里。"),
    );
  else
    void loadLibraryIndex()
      .then((index) => {
        const docs = continuingDocuments(index, getState());
        if (!docs.length)
          reading.append(element("p", "", "目前没有未读完的文章。"));
        else
          docs.forEach((doc) => {
            const link = element("a", "today-document-link");
            link.href = articleUrl(doc.id, true);
            link.append(
              element("strong", "", doc.title),
              element(
                "small",
                "",
                `已读至 ${Math.round(getState()[doc.id].progress)}%`,
              ),
            );
            reading.append(link);
          });
      })
      .catch(() => reading.append(element("p", "", "阅读记录暂时无法读取。")));
  lists?.append(reading);
  below.hidden = false;
}
async function loadDashboard() {
  if (!panel) return;
  const version = ++dashboardVersion;
  try {
    const dashboard = await requestJSON<Dashboard>("/api/dashboard");
    if (isLatestDashboardRequest(version, dashboardVersion)) {
      renderDashboard(dashboard);
    }
  } catch {
    if (!isLatestDashboardRequest(version, dashboardVersion)) return;
    const message = element(
      "p",
      "",
      "今日记录暂时无法读取。请检查连接后重试；静态预览不包含真实活动。",
    );
    const retry = element("button", "quiet-link mint", "重新读取 →");
    retry.type = "button";
    retry.addEventListener("click", () => void loadDashboard());
    panel.replaceChildren(message, retry);
    if (below) below.hidden = true;
  }
}
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!note || !status) return;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button?.disabled) return;
  button!.disabled = true;
  status.textContent = "正在保存…";
  const submitted = note.value;
  try {
    const doc = await saveQuickNote(submitted);
    note.value = retainedDraftAfterSave(note.value, submitted);
    persistDraft();
    status.replaceChildren(document.createTextNode("已保存为草稿。"));
    const link = element("a", "quiet-link mint", "继续编辑 →");
    link.href = dailyDocumentHref(doc);
    status.append(link);
    await loadDashboard();
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
        : "保存失败，请重试。内容仍留在输入框里。";
  } finally {
    if (button) button.disabled = false;
  }
});
note?.addEventListener("input", persistDraft);
note?.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.isComposing
  ) {
    event.preventDefault();
    form?.requestSubmit();
  }
});
void loadDashboard();
document.addEventListener("daily:changed", () => void loadDashboard());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void loadDashboard();
});
window.addEventListener("beforeunload", (event) => {
  if (note?.value) event.preventDefault();
});
