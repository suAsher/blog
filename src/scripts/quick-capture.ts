import { dailyDocumentHref } from "../lib/daily";
import {
  matchesQuickNoteShortcut,
  quickNoteShortcut,
  QUICK_NOTE_DRAFT_KEY,
  QUICK_NOTE_KEY,
  retainedDraftAfterSave,
  saveQuickNote,
} from "../lib/quick-note";
import { element } from "./shared";

const dialog = document.querySelector<HTMLDialogElement>("#capture-dialog");
const form = document.querySelector<HTMLFormElement>("#capture-form");
const source = document.querySelector<HTMLTextAreaElement>("#capture-source");
const status = document.querySelector<HTMLElement>("#capture-status");
const shortcut = document.querySelector<HTMLSelectElement>("#capture-shortcut");
let preference = quickNoteShortcut(null);
try {
  preference = quickNoteShortcut(localStorage.getItem(QUICK_NOTE_KEY));
} catch {
  /* The default works without local storage. */
}
if (shortcut) shortcut.value = preference;
try {
  if (source) source.value = sessionStorage.getItem(QUICK_NOTE_DRAFT_KEY) || "";
} catch {
  /* An empty capture remains usable without tab storage. */
}
function persistDraft() {
  if (!source) return;
  try {
    if (source.value)
      sessionStorage.setItem(QUICK_NOTE_DRAFT_KEY, source.value);
    else sessionStorage.removeItem(QUICK_NOTE_DRAFT_KEY);
  } catch {
    if (status) status.textContent = "浏览器无法临时备份内容，请保持本页打开。";
  }
}
function open() {
  const search = document.querySelector<HTMLDialogElement>(
    "#search-dialog[open]",
  );
  search?.close();
  if (!dialog?.open) dialog?.showModal();
  source?.focus();
}
document
  .querySelectorAll("[data-open-capture]")
  .forEach((button) => button.addEventListener("click", open));
document.addEventListener("quick-capture:open", open);
document
  .querySelector("[data-close-capture]")
  ?.addEventListener("click", () => dialog?.close());
source?.addEventListener("input", persistDraft);
shortcut?.addEventListener("change", () => {
  preference = quickNoteShortcut(shortcut.value);
  try {
    localStorage.setItem(QUICK_NOTE_KEY, preference);
  } catch {
    if (status)
      status.textContent = "快捷键设置仅在本页有效，浏览器未允许保存偏好。";
  }
});
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!source || !status) return;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  status.textContent = "正在保存…";
  const submitted = source.value;
  try {
    const doc = await saveQuickNote(submitted);
    source.value = retainedDraftAfterSave(source.value, submitted);
    persistDraft();
    status.replaceChildren(document.createTextNode("已保存为草稿。"));
    const link = element("a", "quiet-link mint", "继续编辑 →");
    link.href = dailyDocumentHref(doc);
    status.append(link);
    document.dispatchEvent(new CustomEvent("daily:changed"));
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
        : "保存失败，请重试。内容仍在输入框里。";
  } finally {
    if (button) button.disabled = false;
  }
});
source?.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.isComposing
  ) {
    event.preventDefault();
    form?.requestSubmit();
  }
});
document.addEventListener("keydown", (event) => {
  if (matchesQuickNoteShortcut(event, preference)) {
    event.preventDefault();
    open();
  }
});
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
window.addEventListener("beforeunload", (event) => {
  if (source?.value) event.preventDefault();
});
