import {
  ApiError,
  jsonRequest,
  requestJSON,
  type DocumentDetail,
} from "../../lib/documents";
import {
  practiceRecordDraft,
  practiceRecordUpdate,
} from "../../lib/practice-records";
import type { LearningPath } from "../../lib/learning-paths";
import { button, element } from "../workspaces/dom";
import {
  markRecordUncertain,
  recordRecovery,
  recordsKey,
  recordUncertain,
  setRecordRecovery,
  type PracticeRecordsContext,
  type PracticeRecovery,
} from "./records-state";

export function openPracticeRecords(
  context: PracticeRecordsContext,
  mode: "create" | "associate" | "recover",
) {
  document.getElementById("practice-record-dialog")?.remove();
  const key = recordsKey(context);
  let path = context.path,
    busy = false,
    finished = false;
  let pending = recordRecovery(key);
  const dialog = element("dialog", "learn-dialog practice-record-dialog");
  dialog.id = "practice-record-dialog";
  dialog.setAttribute("aria-labelledby", "practice-record-title");
  const heading = element("div", "learn-dialog-heading");
  const title = element("h2", "", "记录这次实践");
  title.id = "practice-record-title";
  const close = button("关闭", () => dialog.close());
  close.className = "button";
  heading.append(title, close);
  const intro = element(
    "p",
    "learn-record-help",
    `${context.chapter.title} · 把操作、结果和失败分析留下来。关联文档不会自动发布，也不会代替实践完成标记。`,
  );
  const form = element("form", "learn-record-form");
  const titleLabel = element("label", "", "记录标题");
  const titleInput = element("input");
  titleInput.required = true;
  titleInput.maxLength = 160;
  titleInput.value = [...`${context.chapter.title} · 实践记录`]
    .slice(0, 160)
    .join("");
  titleLabel.append(titleInput);
  const selectLabel = element("label", "", "选择已有文档");
  const select = element("select");
  select.required = true;
  const option = element("option", "", "选择一篇文档或草稿…");
  option.value = "";
  select.append(option);
  for (const doc of context.documents.filter(
    (item) =>
      item.status !== "trash" &&
      !context.chapter.practiceDocumentIds?.includes(item.id),
  )) {
    const option = element(
      "option",
      "",
      `${doc.title} · ${doc.status === "published" ? "已发布" : "草稿"}`,
    );
    option.value = doc.id;
    select.append(option);
  }
  titleLabel.hidden = mode !== "create";
  titleInput.disabled = mode !== "create";
  selectLabel.hidden = mode !== "associate";
  select.disabled = mode !== "associate";
  selectLabel.append(select);
  const submit = element(
    "button",
    "button button-primary",
    mode === "create" ? "创建草稿并关联" : "关联所选文档",
  );
  submit.type = "submit";
  submit.hidden = mode === "recover";
  form.append(titleLabel, selectLabel, submit);
  const status = element("p", "learn-record-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const links = element("div", "learn-record-links");
  const reload = button("读取最新路线", () => void loadLatest());
  const retry = button("确认关联到最新路线", () => void associate());
  reload.className = retry.className = "button";
  reload.hidden = retry.hidden = true;
  dialog.append(heading, intro, form, status, links, reload, retry);
  document.body.append(dialog);

  function showLinks() {
    links.replaceChildren();
    const link = element(
      "a",
      "quiet-link",
      pending?.documentId ? "继续写作" : "到写作空间检查草稿",
    );
    link.href = pending?.documentId
      ? `/manage/?id=${pending.documentId}`
      : "/manage/";
    links.append(link);
  }
  function freeze(value: boolean) {
    busy = value;
    close.disabled = reload.disabled = retry.disabled = value;
    titleInput.disabled =
      value || mode !== "create" || Boolean(pending) || finished;
    select.disabled =
      value || mode !== "associate" || Boolean(pending) || finished;
    submit.disabled =
      value ||
      Boolean(pending) ||
      finished ||
      (mode === "create" && recordUncertain(key));
  }
  function keep(value: PracticeRecovery) {
    pending = value;
    setRecordRecovery(key, value);
    showLinks();
  }
  function saved(value: LearningPath) {
    path = value;
    finished = true;
    setRecordRecovery(key);
    reload.hidden = retry.hidden = true;
    status.textContent =
      pending?.action === "remove"
        ? "已移除关联，文档仍保留在写作空间。"
        : "已关联到本章。可以继续写作，补充自己的验证过程。";
    context.onSaved(value, pending?.document);
  }
  function failed(error: unknown) {
    const conflict = error instanceof ApiError && error.status === 409;
    status.textContent = `${pending?.created ? "草稿已保存，" : "文档仍然保留，"}${pending?.action === "remove" ? "关联尚未移除。" : "尚未关联。"}${conflict ? "另一处更新了路线。" : error instanceof Error ? error.message : "保存暂时不可用。"} 读取最新路线后可确认重试。`;
    reload.hidden = false;
    retry.hidden = true;
  }
  async function associate() {
    if (busy || !pending) return;
    freeze(true);
    try {
      const input = practiceRecordUpdate(
        path,
        context.chapter.id,
        pending.documentId,
        pending.action,
      );
      saved(
        await requestJSON<LearningPath>(
          `/api/learning-paths/${path.id}`,
          jsonRequest("PUT", input),
        ),
      );
    } catch (error) {
      failed(error);
    } finally {
      freeze(false);
    }
  }
  async function loadLatest() {
    if (busy || !pending) return;
    freeze(true);
    try {
      path = await requestJSON<LearningPath>(`/api/learning-paths/${path.id}`);
      const chapter = path.chapters.find(
        (item) => item.id === context.chapter.id,
      );
      if (!chapter)
        throw new Error(
          "这章已移除，文档仍保留在写作空间。请关闭窗口并选择其他章节。",
        );
      const linked =
        chapter.practiceDocumentIds?.includes(pending.documentId) === true;
      if (linked === (pending.action === "attach")) saved(path);
      else {
        status.textContent =
          "已读取最新路线；你的文档仍保留。确认后只调整这一条关联，保留其他修改。";
        retry.textContent =
          pending.action === "remove"
            ? "确认移除这条关联"
            : "确认关联到最新路线";
        retry.hidden = false;
        reload.hidden = true;
      }
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "读取失败，请重试。";
    } finally {
      freeze(false);
    }
  }
  async function create() {
    if (busy || recordUncertain(key)) return;
    freeze(true);
    status.textContent = "正在创建实践草稿…";
    let submitted = false;
    try {
      const input = practiceRecordDraft(
        path,
        context.chapter.id,
        titleInput.value,
      );
      submitted = true;
      const doc = await requestJSON<DocumentDetail>(
        "/api/documents",
        jsonRequest("POST", input),
      );
      if (!doc || !/^[a-f0-9]{32}$/.test(doc.id))
        throw new ApiError("未收到完整响应。", 0);
      keep({
        documentId: doc.id,
        document: doc,
        action: "attach",
        created: true,
      });
    } catch (error) {
      // A lost response can follow a successful POST. Never automatically retry creation.
      if (
        submitted &&
        !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        )
      ) {
        markRecordUncertain(key);
        status.textContent =
          "草稿可能已创建，但未收到完整响应。请先到写作空间检查草稿，再用「关联已有文档」恢复；本窗口不会重复创建。";
        showLinks();
      } else
        status.textContent =
          error instanceof Error ? error.message : "创建失败，请检查后重试。";
    } finally {
      freeze(false);
    }
    if (pending) await associate();
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || pending || finished) return;
    if (mode === "create") void create();
    else {
      const doc = context.documents.find((item) => item.id === select.value);
      if (!doc) return;
      keep({
        documentId: doc.id,
        document: doc,
        action: "attach",
        created: false,
      });
      void associate();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (!finished) context.onSaved(path, pending?.document);
    dialog.remove();
    document
      .querySelector<HTMLElement>(
        `#chapter-${CSS.escape(context.chapter.id)} .learn-record-create`,
      )
      ?.focus({ preventScroll: true });
  });
  if (pending) {
    status.textContent = "文档已保留，关联尚未完成。读取最新路线后再确认。";
    showLinks();
    reload.hidden = false;
  } else if (mode === "create" && recordUncertain(key)) {
    status.textContent =
      "上次草稿可能已创建。请先到写作空间检查，再通过关联已有文档恢复。";
    showLinks();
  }
  freeze(false);
  dialog.showModal();
  if (mode === "create" && !titleInput.disabled) titleInput.focus();
  else if (mode === "associate" && !select.disabled) select.focus();
  else reload.focus();
}
