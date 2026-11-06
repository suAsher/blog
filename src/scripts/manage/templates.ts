import {
  writingTemplateDraft,
  type WritingTemplateKind,
} from "../../lib/writing-templates";

export function setupWritingTemplates(
  create: (kind: WritingTemplateKind) => Promise<boolean>,
) {
  const dialog = document.querySelector<HTMLDialogElement>(
    "#writing-template-dialog",
  )!;
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const fields = form.querySelector<HTMLFieldSetElement>("fieldset")!;
  const preview = dialog.querySelector<HTMLElement>(
    "#writing-template-preview",
  )!;
  const status = dialog.querySelector<HTMLElement>("#writing-template-status")!;
  const submit = dialog.querySelector<HTMLButtonElement>(
    "#create-from-template",
  )!;
  const close = dialog.querySelector<HTMLButtonElement>(
    "#close-writing-template",
  )!;
  let busy = false;
  const selected = () =>
    form.querySelector<HTMLInputElement>(
      'input[name="writing-template"]:checked',
    )!.value as WritingTemplateKind;
  const render = () => {
    const draft = writingTemplateDraft(selected());
    preview.textContent = draft.source || "一张空白纸，留给自己的思考。";
    status.textContent = "新建为草稿，之后可以自由修改每个标题和段落。";
  };
  form.addEventListener("change", render);
  document
    .querySelector("#open-writing-templates")!
    .addEventListener("click", () => {
      render();
      dialog.showModal();
    });
  close.addEventListener("click", () => {
    if (!busy) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const kind = selected();
    fields.disabled = submit.disabled = close.disabled = true;
    status.textContent = "正在保存当前修改并创建草稿…";
    void create(kind)
      .then((created) => {
        if (created) {
          dialog.close();
          document.querySelector<HTMLInputElement>("#document-title")?.focus();
        } else
          status.textContent =
            "草稿没有创建，请检查页面的保存或连接提示后重试。";
      })
      .catch(() => {
        status.textContent =
          "创建暂时未完成，原有文档保持原样，请检查连接后重试。";
      })
      .finally(() => {
        busy = false;
        fields.disabled = submit.disabled = close.disabled = false;
      });
  });
}
