import {
  requestJSON,
  type DocumentList,
  type DocumentSummary,
} from "../../lib/documents";
import { learningProgress, type LearningPath } from "../../lib/learning-paths";
import { readState } from "../../lib/storage";
import { button, element, get } from "../workspaces/dom";
import { editLearningPath } from "./editor";

let paths: LearningPath[] = [];
let documents: DocumentSummary[] = [];
let currentId = new URL(location.href).searchParams.get("id") || "";
export const availableDocuments = () => documents;
export const currentPath = () => paths.find((path) => path.id === currentId);
const published = () =>
  new Set(
    documents.filter((doc) => doc.status === "published").map((doc) => doc.id),
  );
export async function loadLearningPaths(selectId?: string) {
  get("learn-retry").hidden = true;
  get("learn-status").textContent = "正在读取你的知识路线…";
  try {
    const [result, live, snapshots] = await Promise.all([
      requestJSON<{ paths: LearningPath[] }>("/api/learning-paths"),
      loadDocuments("all"),
      loadDocuments("published"),
    ]);
    paths = result.paths;
    const publishedById = new Map(snapshots.map((doc) => [doc.id, doc]));
    documents = live
      .filter((doc) => doc.status !== "trash")
      .map((doc) =>
        doc.status === "published"
          ? (publishedById.get(doc.id) ?? {
              ...doc,
              title: "已发布文档（标题暂不可用）",
              description: "已发布摘要暂时不可用。",
            })
          : doc,
      );
    if (selectId) {
      currentId = selectId;
      const url = new URL(location.href);
      url.searchParams.set("id", selectId);
      history.replaceState(null, "", url);
    }
    if (!currentId && paths.length) currentId = paths[0].id;
    get("learn-status").textContent = paths.length
      ? `${paths.length} 个方向 · 阅读状态与现有书架共用并随账号同步。`
      : "";
    renderPaths();
    renderDetail();
  } catch (error) {
    get("learn-status").textContent =
      error instanceof Error ? error.message : "路线读取失败。";
    get("learn-retry").hidden = false;
  }
}
async function loadDocuments(status: string): Promise<DocumentSummary[]> {
  const result: DocumentSummary[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const page = await requestJSON<DocumentList>(
      `/api/documents?status=${status}&limit=1000&offset=${offset}`,
    );
    result.push(...page.documents);
    if (result.length >= page.total || !page.documents.length) return result;
  }
  throw new Error("文章超过本页可处理数量，请先整理文档。");
}
function selectPath(id: string) {
  currentId = id;
  const url = new URL(location.href);
  url.searchParams.set("id", id);
  history.replaceState(null, "", url);
  renderPaths();
  renderDetail();
}
function renderPaths() {
  const query = get<HTMLInputElement>("learn-search")
    .value.trim()
    .toLowerCase();
  const visible = paths.filter((path) =>
    `${path.title} ${path.description} ${path.chapters.map((chapter) => chapter.title).join(" ")}`
      .toLowerCase()
      .includes(query),
  );
  get("learn-paths").replaceChildren(
    ...visible.map((path, index) => {
      const progress = learningProgress(
        path.chapters,
        published(),
        readState(),
      );
      const card = button("", () => selectPath(path.id), path.title);
      card.className = "learn-path-card";
      // The whole visible card is its accessible name, including its metadata.
      card.removeAttribute("aria-label");
      card.dataset.accent = path.accent;
      card.setAttribute("aria-current", String(path.id === currentId));
      card.append(
        element(
          "span",
          "learn-path-number",
          `${String(index + 1).padStart(2, "0")} / KNOWLEDGE PATH`,
        ),
        element("strong", "", path.title),
        element(
          "span",
          "learn-path-desc",
          path.description || "给好奇心一个长期的方向。",
        ),
        element(
          "span",
          "learn-path-meta",
          `${path.chapters.length} 章 · ${progress.total} 篇可读 · ${progress.completed} 篇已读`,
        ),
      );
      const meter = element("progress");
      meter.max = Math.max(1, progress.total);
      meter.value = progress.completed;
      meter.setAttribute(
        "aria-label",
        `${path.title} 已读 ${progress.completed} / ${progress.total} 篇`,
      );
      card.append(meter);
      return card;
    }),
  );
  if (query && !visible.length)
    get("learn-paths").append(
      element("p", "learn-empty-filter", "没有匹配的方向，试试其他关键词。"),
    );
  get("learn-empty").hidden = paths.length > 0;
}
function articleLink(id: string, label: string, className = "") {
  const link = element("a", className, label);
  link.href = `/articles/${id}/?path=${currentId}`;
  return link;
}
function renderDetail() {
  const path = currentPath();
  const root = get("learn-detail");
  root.hidden = !path;
  root.replaceChildren();
  if (!path) {
    if (currentId && paths.length)
      get("learn-status").textContent =
        "这条路线不存在或已删除，请选择其他方向。";
    return;
  }
  root.dataset.accent = path.accent;
  const state = readState(),
    progress = learningProgress(path.chapters, published(), state);
  const overview = element("header", "learn-overview");
  const text = element("div");
  text.append(
    element("span", "eyebrow", "YOUR PERSONAL FIELD GUIDE"),
    element("h2", "", path.title),
    element("p", "", path.description),
  );
  const actions = element("div", "learn-overview-actions");
  actions.append(
    element("span", "learn-completion", `${progress.percent}%`),
    element("span", "", `${progress.completed} / ${progress.total} 篇已读`),
  );
  if (progress.next)
    actions.append(
      articleLink(
        progress.next,
        progress.completed ? "继续学习 →" : "开始第一篇 →",
        "button button-primary",
      ),
    );
  else if (progress.total)
    actions.append(element("span", "", "这一程已读完，随时回来重温。"));
  actions.append(button("整理章节", () => editLearningPath(path), "整理章节"));
  overview.append(text, actions);
  const layout = element("div", "learn-curriculum");
  const navigation = element("nav", "learn-chapter-nav");
  navigation.setAttribute("aria-label", "章节目录");
  navigation.append(element("span", "eyebrow", "CONTENTS / 章节目录"));
  const chapters = element("div", "learn-chapters");
  path.chapters.forEach((chapter, index) => {
    const number = String(index + 1).padStart(2, "0");
    const anchor = element("a", "", `${number}　${chapter.title}`);
    anchor.href = `#chapter-${chapter.id}`;
    navigation.append(anchor);
    const section = element("details", "learn-chapter");
    section.id = `chapter-${chapter.id}`;
    section.open = true;
    const summary = element("summary");
    summary.append(
      element("span", "learn-chapter-number", number),
      element("h3", "", chapter.title),
      element(
        "span",
        "learn-chapter-count",
        `${chapter.documentIds.length} 篇　⌄`,
      ),
    );
    section.append(summary);
    if (chapter.description)
      section.append(
        element("p", "learn-chapter-description", chapter.description),
      );
    const lessons = element("ol", "learn-lessons");
    chapter.documentIds.forEach((id, lessonIndex) => {
      const doc = documents.find((value) => value.id === id),
        row = element("li");
      row.append(
        element(
          "span",
          "learn-lesson-number",
          `${number}.${String(lessonIndex + 1).padStart(2, "0")}`,
        ),
      );
      const body = element("div", "learn-lesson-body");
      if (doc?.status === "published") {
        body.append(articleLink(id, doc.title));
        body.append(
          element("p", "", doc.description || "留下一点理解，带走一个新问题。"),
        );
        row.append(
          body,
          element(
            "span",
            state[id]?.read ? "learn-is-read" : "learn-reading-status",
            state[id]?.read
              ? "✓ 已读"
              : state[id]?.progress
                ? `已读 ${Math.round(state[id].progress)}%`
                : `${doc.readingMinutes} 分钟 →`,
          ),
        );
      } else if (doc?.status === "draft") {
        const link = element("a", "", doc.title);
        link.href = `/manage/?id=${id}`;
        body.append(
          link,
          element("p", "", "这篇文章还在生长，发布后即可进入学习路线。"),
        );
        row.append(
          body,
          element("span", "learn-reading-status", "草稿 · 去写作 ↗"),
        );
      } else {
        body.append(
          element("strong", "", "文章暂不可用"),
          element("p", "", "引用仍然保留，可在整理章节中调整。"),
        );
        row.append(body);
      }
      lessons.append(row);
    });
    if (!chapter.documentIds.length)
      section.append(
        element(
          "p",
          "learn-chapter-description",
          "这一章等待你的第一篇文章。点击「整理章节」加入已有文档，或去写作空间开始记录。",
        ),
      );
    section.append(lessons);
    chapters.append(section);
  });
  if (!path.chapters.length)
    chapters.append(
      element("p", "learn-empty", "先画出路线：点击「整理章节」，添加第一章。"),
    );
  layout.append(navigation, chapters);
  root.append(overview, layout);
}
get("learn-create").addEventListener("click", () => editLearningPath());
get("learn-empty-create").addEventListener("click", () => editLearningPath());
get("learn-search").addEventListener("input", renderPaths);
get("learn-retry").addEventListener("click", () => void loadLearningPaths());
document.addEventListener("reading:change", () => {
  renderPaths();
  renderDetail();
});
void loadLearningPaths();
