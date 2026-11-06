import { explorerMarkdown } from "../../lib/writing-templates";
import { enhanceContent } from "../content-blocks";
import type { SelectionRange } from "../../lib/writing-tools";

export interface ExplorerInsertionTarget extends SelectionRange {
  id: string;
  source: string;
}
export class ExplorerBlockDialog {
  private dialog = document.querySelector<HTMLDialogElement>(
    "#explorer-config-dialog",
  )!;
  private form = this.dialog.querySelector<HTMLFormElement>("form")!;
  private model =
    this.dialog.querySelector<HTMLSelectElement>("#explorer-model")!;
  private title =
    this.dialog.querySelector<HTMLInputElement>("#explorer-title")!;
  private preview = this.dialog.querySelector<HTMLElement>(
    "#explorer-config-preview",
  )!;
  private status = this.dialog.querySelector<HTMLElement>(
    "#explorer-config-status",
  )!;
  private target: ExplorerInsertionTarget | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private options: {
      target: () => ExplorerInsertionTarget | undefined;
      insert: (markdown: string, target: ExplorerInsertionTarget) => boolean;
    },
  ) {
    document
      .querySelector("#configure-explorer")!
      .addEventListener("click", () => this.open());
    document
      .querySelector("#close-explorer-config")!
      .addEventListener("click", () => this.close());
    this.dialog.addEventListener("close", () => this.reset());
    this.form.addEventListener("input", (event) => {
      if (event.target !== this.model && event.target !== this.title) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.render(), 250);
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.target) return;
      try {
        const markdown = explorerMarkdown(this.model.value, this.title.value);
        if (!this.options.insert(markdown, this.target)) {
          this.status.textContent =
            "当前文档已切换或不可编辑，请关闭后重新选择插入位置。";
          return;
        }
        this.close();
        document
          .querySelector<HTMLTextAreaElement>("#document-source")
          ?.focus();
      } catch (error) {
        this.status.textContent =
          error instanceof Error ? error.message : "请检查教学模型配置。";
      }
    });
  }
  private open() {
    this.target = this.options.target();
    if (!this.target) return;
    this.dialog.showModal();
    this.render();
  }
  close() {
    if (this.dialog.open) this.dialog.close();
    this.reset();
  }
  private reset() {
    clearTimeout(this.timer);
    this.target = undefined;
    this.preview.replaceChildren();
  }
  private render() {
    if (!this.dialog.open) return;
    try {
      const markdown = explorerMarkdown(this.model.value, this.title.value);
      const definition = markdown.split("\n").slice(2, -2).join("\n");
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-explore";
      code.textContent = definition;
      pre.append(code);
      this.preview.replaceChildren(pre);
      enhanceContent(this.preview);
      this.status.textContent =
        "预览使用正式阅读组件。每篇最多增强 3 个实验；正文保留普通 Markdown 定义。";
    } catch (error) {
      this.preview.replaceChildren();
      this.status.textContent =
        error instanceof Error ? error.message : "请检查教学模型配置。";
    }
  }
}
