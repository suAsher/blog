import { jsonRequest, requestJSON } from "../../lib/documents";
import { practiceRecordUpdate } from "../../lib/practice-records";
import type { LearningPath } from "../../lib/learning-paths";
import { button, element } from "../workspaces/dom";
import { openPracticeRecords } from "./records-dialog";
import {
  recordRecovery,
  recordsKey,
  setRecordRecovery,
  type PracticeRecordsContext,
} from "./records-state";

export function practiceRecords(context: PracticeRecordsContext) {
  const { path, chapter, documents, onSaved } = context;
  const key = recordsKey(context);
  const panel = element("section", "learn-records");
  panel.setAttribute("aria-label", `${chapter.title}的实践记录`);
  const heading = element("div", "learn-record-heading");
  const headingText = element("div");
  headingText.append(
    element("span", "eyebrow", "EVIDENCE / 留下做过的痕迹"),
    element("h4", "", "你的实践记录"),
  );
  heading.append(
    headingText,
    element(
      "span",
      "learn-record-count",
      `${chapter.practiceDocumentIds?.length || 0} / 20`,
    ),
  );
  const list = element("ul", "learn-record-list");
  for (const id of chapter.practiceDocumentIds || []) {
    const doc = documents.find(
      (item) => item.id === id && item.status !== "trash",
    );
    const row = element("li", "learn-record");
    const body = element("div", "learn-record-body");
    body.append(
      element(
        "span",
        "learn-record-kind",
        doc?.status === "published"
          ? "已发布成果"
          : doc
            ? "生长中的草稿"
            : "引用保留",
      ),
    );
    if (doc) {
      const link = element("a", "learn-record-title", doc.title);
      link.href =
        doc.status === "published"
          ? `/articles/${id}/?path=${path.id}`
          : `/manage/?id=${id}`;
      body.append(link);
      if (doc.description) body.append(element("p", "", doc.description));
    } else
      body.append(
        element("strong", "", "实践记录暂不可用"),
        element("p", "", "文档已移入垃圾箱或被移除，关联仍然保留。"),
      );
    const actions = element("div", "learn-record-actions");
    if (doc) {
      const edit = element("a", "quiet-link", "继续写作 ↗");
      edit.href = `/manage/?id=${id}`;
      edit.setAttribute("aria-label", `继续写作 ↗：${doc.title}`);
      actions.append(edit);
    }
    const remove = button(
      "移除关联",
      () => void unlink(id, remove),
      `移除关联：${doc?.title || "暂不可用的记录"}`,
    );
    remove.className = "quiet-link";
    actions.append(remove);
    row.append(body, actions);
    list.append(row);
  }
  const controls = element("div", "learn-record-controls");
  const create = button("新建实践记录", () =>
    openPracticeRecords(context, "create"),
  );
  create.className = "button learn-record-create";
  const attach = button("关联已有文档", () =>
    openPracticeRecords(context, "associate"),
  );
  attach.className = "button";
  const full =
    (chapter.practiceDocumentIds?.length || 0) >= 20 ||
    path.chapters.reduce(
      (count, item) => count + (item.practiceDocumentIds?.length || 0),
      0,
    ) >= 100;
  create.disabled = attach.disabled = full;
  controls.append(create, attach);
  const status = element("p", "learn-record-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const recovery = recordRecovery(key);
  if (recovery) {
    status.textContent = "有一条文档关联尚未完成；内容仍保留在写作空间。";
    controls.append(
      button("恢复关联", () => openPracticeRecords(context, "recover")),
    );
    const edit = element("a", "quiet-link", "打开保留的文档 ↗");
    edit.href = `/manage/?id=${recovery.documentId}`;
    controls.append(edit);
  }
  panel.append(heading, list);
  if (!chapter.practiceDocumentIds?.length)
    panel.append(
      element(
        "p",
        "learn-record-empty",
        "把一次实验变成自己的理解。留下代码、输出与失败分析，下次从证据继续。",
      ),
    );
  panel.append(
    controls,
    element(
      "small",
      "learn-record-help",
      full
        ? "已达到关联预算。移除不再需要的关联后，可以继续添加；文档会保留。"
        : "成果记录、阅读进度与实践完成标记各自独立。每章最多关联 20 篇，路线总计最多 100 次引用。",
    ),
    status,
  );

  async function unlink(id: string, control: HTMLButtonElement) {
    if (control.disabled) return;
    control.disabled = true;
    status.textContent = "正在移除关联…";
    try {
      const saved = await requestJSON<LearningPath>(
        `/api/learning-paths/${path.id}`,
        jsonRequest(
          "PUT",
          practiceRecordUpdate(path, chapter.id, id, "remove"),
        ),
      );
      setRecordRecovery(key);
      onSaved(saved);
      document
        .querySelector<HTMLElement>(
          `#chapter-${CSS.escape(chapter.id)} .learn-record-create`,
        )
        ?.focus({ preventScroll: true });
    } catch (error) {
      setRecordRecovery(key, {
        documentId: id,
        action: "remove",
        created: false,
      });
      status.textContent =
        error instanceof Error ? error.message : "关联尚未移除。";
      openPracticeRecords(context, "recover");
    } finally {
      control.disabled = false;
    }
  }
  return panel;
}
