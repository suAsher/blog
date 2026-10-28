import {
  requestJSON,
  type DocumentContent,
  type DocumentDetail,
} from "../../lib/documents";
import {
  compareContent,
  getRevision,
  listRevisions,
  restoreRevision,
  type RevisionSummary,
} from "../../lib/import-inbox";
import { errorMessage } from "./utilities";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const asContent = (doc: DocumentDetail): DocumentContent => ({
  ...doc,
  category: doc.category || "",
});
const reasonLabels: Record<string, string> = {
  create: "创建",
  created: "创建",
  save: "保存",
  update: "编辑保存",
  publish: "发布",
  published: "发布",
  import: "导入",
  restore: "恢复版本",
};

export function renderComparison(
  area: HTMLElement,
  before: DocumentContent,
  after: DocumentContent,
  renderedChanged = false,
) {
  const diff = compareContent(before, after);
  area.replaceChildren();
  if (renderedChanged) {
    const notice = document.createElement("p");
    notice.className = "revision-render-notice";
    notice.textContent =
      "工作稿与线上渲染内容有变化，可能涉及配图映射或知识链接。请核对对照预览；正式发布仍按已发布文档的链接规则呈现。";
    area.append(notice);
  }
  if (!diff.fields.length && !diff.sourceChanged) {
    if (renderedChanged) return;
    const p = document.createElement("p");
    p.textContent = "标题、文档信息与正文均无变化。";
    area.append(p);
    return;
  }
  if (diff.fields.length) {
    const list = document.createElement("dl");
    list.className = "revision-fields";
    for (const field of diff.fields) {
      const label = document.createElement("dt");
      label.textContent = field.label;
      const values = document.createElement("dd");
      const removed = document.createElement("del");
      removed.textContent = field.before || "（未设置）";
      const added = document.createElement("ins");
      added.textContent = field.after || "（未设置）";
      values.append(removed, added);
      list.append(label, values);
    }
    area.append(list);
  }
  if (diff.sourceChanged) {
    const pre = document.createElement("pre");
    pre.className = "revision-source";
    pre.setAttribute("aria-label", "正文差异，减号为旧版，加号为当前工作副本");
    for (const line of diff.lines) {
      const span = document.createElement("span");
      span.className = `diff-${line.kind}`;
      span.textContent = `${line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "} ${line.text}`;
      pre.append(span);
    }
    area.append(pre);
  }
  if (diff.truncated) {
    const p = document.createElement("p");
    p.textContent =
      "内容超出预览范围：对比前 10000 行，最多显示 400 行，每项最多 2000 字符。完整原文可从编辑器导出。";
    area.append(p);
  }
}

export class RevisionDialogs {
  private historyDialog = element<HTMLDialogElement>("history-dialog");
  private publishDialog = element<HTMLDialogElement>("publish-review-dialog");
  private revision: number | undefined;
  private sequence = 0;
  private restoring = false;

  constructor() {
    element("close-document-history").addEventListener("click", () => {
      if (!this.restoring) this.historyDialog.close();
    });
    this.historyDialog.addEventListener("cancel", (event) => {
      if (this.restoring) event.preventDefault();
    });
    element("cancel-publish-review").addEventListener("click", () =>
      this.publishDialog.close("cancel"),
    );
    element("confirm-publish").addEventListener("click", () =>
      this.publishDialog.close("publish"),
    );
  }

  async reviewPublished(doc: DocumentDetail): Promise<boolean> {
    const published = await requestJSON<DocumentDetail>(
      `/api/documents/${encodeURIComponent(doc.id)}?view=published`,
    );
    element("publish-review-title").textContent = `发布前，再看一眼变化`;
    element("publish-review-document").textContent = doc.title;
    renderComparison(
      element("publish-comparison"),
      asContent(published),
      asContent(doc),
      published.html !== doc.html,
    );
    this.publishDialog.returnValue = "";
    return new Promise((resolve) => {
      this.publishDialog.addEventListener(
        "close",
        () => resolve(this.publishDialog.returnValue === "publish"),
        { once: true },
      );
      this.publishDialog.showModal();
      element("cancel-publish-review").focus();
    });
  }

  async open(doc: DocumentDetail): Promise<DocumentDetail | undefined> {
    this.revision = undefined;
    this.restoring = false;
    const sequence = ++this.sequence;
    element("history-document-title").textContent = doc.title;
    element("revision-list").textContent = "正在读取保存的历史版本…";
    element("revision-comparison").textContent =
      "选择一个版本，与当前工作副本对照。";
    element("revision-error").hidden = true;
    element<HTMLButtonElement>("restore-revision").disabled = true;
    this.historyDialog.showModal();
    let restored: DocumentDetail | undefined;
    const onRestore = async () => {
      if (this.revision === undefined || this.restoring) return;
      this.restoring = true;
      element<HTMLButtonElement>("restore-revision").disabled = true;
      element<HTMLButtonElement>("close-document-history").disabled = true;
      element("revision-error").hidden = true;
      element("revision-busy").textContent = "正在恢复为新的工作副本…";
      try {
        restored = await restoreRevision(doc.id, doc.version, this.revision);
        this.historyDialog.close();
      } catch (error) {
        element("revision-error").textContent = errorMessage(error);
        element("revision-error").hidden = false;
      } finally {
        this.restoring = false;
        element("revision-busy").textContent = "";
        element<HTMLButtonElement>("restore-revision").disabled =
          this.revision === undefined;
        element<HTMLButtonElement>("close-document-history").disabled = false;
      }
    };
    element("restore-revision").addEventListener("click", onRestore);
    const closed = new Promise<DocumentDetail | undefined>((resolve) => {
      this.historyDialog.addEventListener(
        "close",
        () => {
          ++this.sequence;
          element("restore-revision").removeEventListener("click", onRestore);
          resolve(restored);
        },
        { once: true },
      );
    });
    void listRevisions(doc.id)
      .then(({ history }) => {
        if (sequence !== this.sequence || !this.historyDialog.open) return;
        this.renderList(doc, history);
      })
      .catch((error) => {
        if (sequence !== this.sequence || !this.historyDialog.open) return;
        element("revision-list").textContent = "";
        element("revision-error").textContent = errorMessage(error);
        element("revision-error").hidden = false;
      });
    return closed;
  }

  private renderList(doc: DocumentDetail, history: RevisionSummary[]) {
    const list = element("revision-list");
    list.replaceChildren();
    if (!history.length) {
      list.textContent = "尚无历史版本。接下来的保存会保留工作副本快照。";
      return;
    }
    for (const item of history) {
      const button = document.createElement("button");
      button.type = "button";
      const title = document.createElement("strong");
      title.textContent = item.title;
      const info = document.createElement("span");
      info.textContent = `版本 ${item.revision} · ${reasonLabels[item.reason] || item.reason} · ${new Date(item.savedAt).toLocaleString("zh-CN")}`;
      button.append(title, info);
      button.addEventListener("click", () => {
        if (this.restoring) return;
        list
          .querySelectorAll("button")
          .forEach((other) =>
            other.setAttribute("aria-pressed", String(other === button)),
          );
        void this.selectRevision(doc, item.revision);
      });
      list.append(button);
    }
  }

  private async selectRevision(doc: DocumentDetail, revision: number) {
    const sequence = ++this.sequence;
    this.revision = undefined;
    element<HTMLButtonElement>("restore-revision").disabled = true;
    element("revision-error").hidden = true;
    element("revision-comparison").textContent = "正在读取该版本…";
    try {
      const result = await getRevision(doc.id, revision);
      if (sequence !== this.sequence || !this.historyDialog.open) return;
      this.revision = revision;
      element("revision-comparison-title").textContent =
        `历史版本 ${revision} → 当前工作副本`;
      renderComparison(
        element("revision-comparison"),
        result.content,
        asContent(doc),
      );
      element<HTMLButtonElement>("restore-revision").disabled =
        doc.status === "trash";
    } catch (error) {
      if (sequence !== this.sequence || !this.historyDialog.open) return;
      element("revision-comparison").textContent =
        "版本读取失败，当前工作副本保持不变。";
      element("revision-error").textContent = errorMessage(error);
      element("revision-error").hidden = false;
    }
  }
}
