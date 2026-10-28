import {
  requestJSON,
  type DocumentDetail,
  type DocumentSummary,
} from "../../lib/documents";
import { button, element, get } from "./dom";
import { comparisonSelection } from "../../lib/workspaces";

let revision = 0;
let candidates: DocumentSummary[] = [];
const selection = () => [
  get<HTMLSelectElement>("ws-compare-left"),
  get<HTMLSelectElement>("ws-compare-right"),
];
export function setComparisonDocuments(documents: DocumentSummary[]) {
  candidates = documents.filter((doc) => doc.status === "published");
  const values = comparisonSelection(
    candidates.map((doc) => doc.id),
    selection().map((select) => select.value),
  );
  selection().forEach((select, index) => {
    select.replaceChildren(
      ...candidates.map((doc) => {
        const option = element("option", "", doc.title);
        option.value = doc.id;
        return option;
      }),
    );
    select.value = values[index];
    select.disabled = !candidates.length;
  });
}
export async function renderComparison() {
  const current = ++revision;
  const target = get("ws-comparison");
  if (candidates.length < 2) {
    target.replaceChildren(
      element(
        "p",
        "ws-view-empty",
        "加入至少两篇已发布文章，就能在这里对照阅读。草稿会继续保留在阅读路径中。",
      ),
    );
    return;
  }
  const ids = selection().map((select) => select.value);
  if (ids[0] === ids[1]) {
    target.replaceChildren(
      element(
        "p",
        "ws-view-empty",
        "请选择两篇不同的文章，看看它们如何回应同一个问题。",
      ),
    );
    return;
  }
  target.replaceChildren(
    element("p", "ws-view-empty", "正在读取两篇文章的已发布版本…"),
  );
  const results = await Promise.allSettled(
    ids.map((id) =>
      requestJSON<DocumentDetail>(
        `/api/documents/${encodeURIComponent(id)}?view=published`,
      ),
    ),
  );
  if (revision !== current) return;
  target.replaceChildren(
    ...results.map((result, index) => {
      const panel = element("article", "ws-compare-article");
      panel.append(
        element(
          "span",
          "eyebrow",
          index ? "PERSPECTIVE / 02" : "PERSPECTIVE / 01",
        ),
      );
      if (result.status === "rejected" || result.value.status !== "published") {
        panel.append(
          element("h3", "", "文章当前不可对照"),
          element(
            "p",
            "",
            "它可能已取消发布、被移入回收站，或暂时无法读取。阅读路径中的引用仍然保留。",
          ),
          button("重新读取正文", () => void renderComparison()),
        );
        return panel;
      }
      const document = result.value;
      const link = element("a", "ws-compare-title", document.title);
      link.href = `/articles/${encodeURIComponent(document.id)}/`;
      const heading = element("h3");
      heading.append(link);
      panel.append(
        heading,
        element("p", "ws-compare-meta", `已发布版本 · ${document.date}`),
      );
      const body = element("div", "ws-compare-body");
      // This endpoint renders and sanitizes the published snapshot on the server.
      // Never substitute the working document or its source when unavailable.
      body.innerHTML = document.html;
      body.querySelectorAll("pre").forEach((block) => {
        block.tabIndex = 0;
        block.setAttribute("role", "region");
        block.setAttribute("aria-label", "代码块，可左右滚动");
      });
      body.querySelectorAll("table").forEach((table) => {
        const wrapper = element("div", "ws-compare-table");
        wrapper.tabIndex = 0;
        wrapper.setAttribute("role", "region");
        wrapper.setAttribute("aria-label", "文章表格，可左右滚动");
        table.before(wrapper);
        wrapper.append(table);
      });
      panel.append(body);
      return panel;
    }),
  );
}
selection().forEach((select) =>
  select.addEventListener("change", () => void renderComparison()),
);
