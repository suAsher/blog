import type { Annotation } from "../lib/annotations";
import { jsonRequest, requestJSON, type DocumentDetail } from "../lib/documents";
import { recallNoteContent } from "../lib/recall";
import { shanghaiToday } from "../lib/quick-note";
import "../styles/recall.css";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = "") {
  const value = document.createElement(tag);
  value.textContent = text;
  return value;
}

export function openRecallComposer(
  annotation: Annotation,
  trigger: HTMLButtonElement,
  signal: AbortSignal,
  onSaved: (note: DocumentDetail) => void,
) {
  if (signal.aborted || document.getElementById("recall-compose")) return;
  const dialog = node("dialog");
  dialog.id = "recall-compose";
  dialog.className = "recall-compose";
  dialog.setAttribute("aria-labelledby", "recall-compose-title");
  const form = node("form");
  const title = node("h2", "把摘录变成一个问题");
  title.id = "recall-compose-title";
  const hint = node("p", "先写下你希望日后能独立回答的问题。保存为普通笔记草稿；发布后，可在阅读页加入现有回顾计划。");
  const questionLabel = node("label", "复习问题");
  const question = node("textarea");
  question.id = "recall-question-input";
  question.required = true;
  question.rows = 2;
  question.maxLength = 800; // Unicode character budget is checked by parseRecall.
  question.placeholder = "例如：为什么增加并发后，首个响应反而更慢？";
  questionLabel.htmlFor = question.id;
  questionLabel.append(question);
  const answerLabel = node("label", "参考解释");
  const answer = node("textarea");
  answer.id = "recall-answer-input";
  answer.required = true;
  answer.rows = 7;
  answer.maxLength = 8000;
  answer.value = [annotation.quote.exact, annotation.body].filter(Boolean).join("\n\n");
  answerLabel.htmlFor = answer.id;
  answerLabel.append(answer);
  const budget = node("p", "问题最多 400 字，解释最多 4000 字，整张卡片最多 12 KiB。内容按普通文字展示。原始批注继续保留。");
  const error = node("p");
  error.className = "recall-compose-error";
  error.setAttribute("role", "status");
  const actions = node("div");
  actions.className = "recall-compose-actions";
  const cancel = node("button", "取消");
  cancel.type = "button";
  cancel.className = "button";
  const submit = node("button", "保存问题卡草稿");
  submit.type = "submit";
  submit.className = "button button-primary";
  actions.append(cancel, submit);
  form.append(title, hint, questionLabel, answerLabel, budget, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  let busy = false;
  const cleanup = () => {
    dialog.close();
    dialog.remove();
    signal.removeEventListener("abort", cleanup);
    if (!signal.aborted && trigger.isConnected && !trigger.hidden) trigger.focus();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  dialog.addEventListener("close", cleanup, { once: true });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  cancel.addEventListener("click", () => { if (!busy) dialog.close(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || signal.aborted) return;
    error.textContent = "";
    try {
      const content = recallNoteContent(annotation, question.value, answer.value, shanghaiToday());
      busy = true;
      [submit, cancel, question, answer].forEach((control) => { control.disabled = true; });
      const note = await requestJSON<DocumentDetail>("/api/documents", {
        ...jsonRequest("POST", content), signal,
      });
      if (signal.aborted) return;
      dialog.close();
      onSaved(note);
    } catch (failure) {
      if (!signal.aborted) error.textContent = `${failure instanceof Error ? failure.message : "保存结果未确认。"} 输入已保留；连接中断时请先到写作空间核对是否已创建。`;
    } finally {
      busy = false;
      [submit, cancel, question, answer].forEach((control) => { control.disabled = false; });
    }
  });
  dialog.showModal();
  question.focus();
}
