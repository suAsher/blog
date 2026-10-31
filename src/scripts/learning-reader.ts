import { requestJSON, type DocumentSummary } from "../lib/documents";
import { lessonNeighbors } from "../lib/learning-navigation";
import { element, patchEntry } from "./shared";

type Path = {
  id: string;
  title: string;
  chapters: { title: string; documentIds: string[] }[];
};

export async function initLearningNavigation(documentId: string) {
  const pathId = new URLSearchParams(location.search).get("path");
  const target = document.getElementById("learning-navigation");
  if (!pathId || !/^[a-f0-9]{32}$/.test(pathId) || !target) return;
  target.hidden = false;
  const back = element("a", "quiet-link mint", "返回技术路线");
  back.href = `/learn/?id=${pathId}`;
  const breadcrumb = document.getElementById("back-to-articles");
  if (breadcrumb instanceof HTMLAnchorElement) {
    breadcrumb.href = back.href;
    breadcrumb.textContent = "← 返回技术路线";
  }
  target.replaceChildren(back, element("p", "", "正在连接这篇文章的学习路线…"));
  try {
    const path = await requestJSON<Path>(`/api/learning-paths/${pathId}`);
    const documents: DocumentSummary[] = [];
    for (let offset = 0; offset < 10000; offset += 1000) {
      const page = await requestJSON<{
        documents: DocumentSummary[];
        total: number;
      }>(`/api/documents?status=published&limit=1000&offset=${offset}`);
      documents.push(...page.documents);
      if (
        offset + page.documents.length >= page.total ||
        !page.documents.length
      )
        break;
    }
    const titles = new Map(documents.map((doc) => [doc.id, doc.title]));
    const neighbors = lessonNeighbors(
      path.chapters,
      new Set(titles.keys()),
      documentId,
    );
    if (!neighbors) {
      target.replaceChildren(
        back,
        element(
          "p",
          "",
          "这篇文章已不在当前可读路线中，可以返回目录选择其他章节。",
        ),
      );
      return;
    }
    renderRouteOutline(path, titles, pathId, documentId);
    const heading = element("h2", "", path.title);
    const meta = element(
      "p",
      "",
      `${neighbors.chapter} · 第 ${neighbors.index} / ${neighbors.total} 篇可读文章`,
    );
    const links = element("div", "learning-reader-links");
    for (const [label, id] of [
      ["上一节", neighbors.previous],
      ["下一节", neighbors.next],
    ]) {
      if (!id) continue;
      const link = element("a", "button", `${label} · ${titles.get(id)}`);
      link.href = `/articles/${id}/?path=${pathId}`;
      links.append(link);
    }
    const complete = element(
      "button",
      "button button-primary",
      neighbors.next ? "完成本节，继续学习 →" : "完成本节，返回路线",
    );
    complete.type = "button";
    complete.addEventListener("click", () => {
      if (!patchEntry(documentId, { read: true })) return;
      location.assign(
        neighbors.next
          ? `/articles/${neighbors.next}/?path=${pathId}`
          : back.href,
      );
    });
    target.replaceChildren(back, heading, meta, links, complete);
  } catch {
    const retry = element("button", "button", "重新读取路线");
    retry.type = "button";
    retry.addEventListener(
      "click",
      () => void initLearningNavigation(documentId),
    );
    target.replaceChildren(
      back,
      element("p", "", "路线暂时无法读取，正文阅读不受影响。"),
      retry,
    );
  }
}

function renderRouteOutline(
  path: Path,
  titles: Map<string, string>,
  pathId: string,
  current: string,
) {
  for (const targetId of [
    "reader-route-outline",
    "reader-mobile-route-outline",
  ]) {
    const target = document.getElementById(targetId);
    if (!target) continue;
    const sections = path.chapters.map((chapter) => {
      const group = element("details", "reader-route-chapter");
      group.open = chapter.documentIds.includes(current);
      group.append(element("summary", "", chapter.title));
      const list = element("ol");
      chapter.documentIds.forEach((id) => {
        if (!titles.has(id)) return;
        const row = element("li");
        const link = element("a", "", titles.get(id));
        link.href = `/articles/${id}/?path=${pathId}`;
        if (id === current) link.setAttribute("aria-current", "page");
        row.append(link);
        list.append(row);
      });
      if (list.childElementCount) group.append(list);
      else group.append(element("p", "", "本章尚无可读文章"));
      return group;
    });
    target.replaceChildren(...sections);
  }
  document.getElementById("reader-route-sidebar")?.removeAttribute("hidden");
  document.getElementById("reader-mobile-route")?.removeAttribute("hidden");
}
