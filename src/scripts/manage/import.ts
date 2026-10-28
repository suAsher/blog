import { formatBytes, type Quota } from "../../lib/documents";
import {
  buildImportDecisions,
  importDocuments,
  listImportReports,
  previewImport,
  type ImportAction,
  type ImportCandidate,
  type ImportPreview,
  type SavedImportReport,
  type SelectedImport,
} from "../../lib/import-inbox";
import { errorMessage } from "./utilities";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const allowed = /\.(md|markdown|txt|png|jpe?g|gif|webp)$/i;
const image = /\.(png|jpe?g|gif|webp)$/i;
const unsafe =
  /(^|\/)(\.[^/]*|node_modules|vendor|id_rsa[^/]*|id_ed25519[^/]*|secrets?)(\/|$)|\.(pem|key|p12|pfx)$/i;
const statusLabels = {
  new: "新文档",
  duplicate: "与已有内容相同",
  changed: "内容有变化",
  invalid: "无法导入",
};

export class DocumentImporter {
  private selection: SelectedImport[] = [];
  private skipped: string[] = [];
  private choices: Record<string, ImportAction> = {};
  private preview: ImportPreview | undefined;
  private previewTask: Promise<void> | undefined;
  private selectionVersion = 0;
  private busy = false;
  private problem = "";
  private requestId = "";
  private dialog = element<HTMLDialogElement>("import-dialog");

  constructor(
    private callbacks: {
      imported: (result: SavedImportReport) => Promise<void>;
      quota: (quota: Quota) => void;
      openDocument: (id: string) => Promise<void>;
    },
  ) {
    element<HTMLInputElement>("import-folder").setAttribute(
      "webkitdirectory",
      "",
    );
    element("close-import").addEventListener("click", () => this.close());
    this.dialog.addEventListener("cancel", (event) => {
      if (this.busy) event.preventDefault();
    });
    this.dialog.addEventListener("click", (event) => {
      if (event.target !== this.dialog) return;
      const bounds = this.dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        this.close();
    });
    for (const kind of ["files", "folder"]) {
      element(`choose-import-${kind}`).addEventListener("click", () => {
        const input = element<HTMLInputElement>(`import-${kind}`);
        input.value = "";
        input.click();
      });
      element<HTMLInputElement>(`import-${kind}`).addEventListener(
        "change",
        (event) =>
          this.select([...((event.target as HTMLInputElement).files || [])]),
      );
    }
    const dropzone = element("import-dropzone");
    for (const name of ["dragenter", "dragover"])
      dropzone.addEventListener(name, (event) => {
        event.preventDefault();
        dropzone.classList.add("is-dragging");
      });
    dropzone.addEventListener("dragleave", () =>
      dropzone.classList.remove("is-dragging"),
    );
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
      if (!this.busy)
        this.select([...((event as DragEvent).dataTransfer?.files || [])]);
    });
    element("clear-import-selection").addEventListener("click", () =>
      this.select([]),
    );
    element("confirm-import").addEventListener(
      "click",
      () => void this.submit(),
    );
    element("retry-import-preview").addEventListener("click", () =>
      this.startPreview(),
    );
    element("open-import-reports").addEventListener(
      "click",
      () => void this.loadReports(),
    );
  }

  open() {
    if (!this.dialog.open) this.dialog.showModal();
  }
  private close() {
    if (!this.busy) this.dialog.close();
  }
  private select(files: File[]) {
    if (this.busy) return;
    ++this.selectionVersion;
    this.preview = undefined;
    this.previewTask = undefined;
    this.choices = {};
    this.requestId = crypto.randomUUID().replaceAll("-", "");
    const entries = files.map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
    this.skipped = entries
      .filter((item) => !allowed.test(item.path) || unsafe.test(item.path))
      .map((item) => item.path);
    this.selection = entries.filter(
      (item) => allowed.test(item.path) && !unsafe.test(item.path),
    );
    element("import-report").hidden = true;
    element("import-preview").hidden = true;
    element("import-error").hidden = true;
    element("retry-import-preview").hidden = true;
    this.renderSelection();
    if (this.selection.length && !this.problem) this.startPreview();
  }

  private renderSelection() {
    const total = this.selection.reduce((sum, item) => sum + item.file.size, 0);
    const documents = this.selection.filter((item) =>
      /\.(md|markdown|txt)$/i.test(item.path),
    ).length;
    element("import-selection").hidden =
      this.selection.length + this.skipped.length === 0;
    element("import-selection-count").textContent =
      `${documents} 篇文档 · ${this.selection.length - documents} 张图片`;
    element("import-selection-detail").textContent =
      `共 ${formatBytes(total)} · 预检会读取正文、相对路径与配图，不会保存文档。`;
    const list = element("import-file-list");
    list.replaceChildren();
    this.selection.slice(0, 60).forEach((item) => {
      const line = document.createElement("li");
      line.textContent = `${item.path} · ${formatBytes(item.file.size)}`;
      list.append(line);
    });
    if (this.selection.length > 60)
      this.lines(list, [`另有 ${this.selection.length - 60} 个文件`]);
    element("import-skip-note").hidden = !this.skipped.length;
    element("import-skip-note").textContent =
      `已跳过 ${this.skipped.length} 个不支持、隐藏或可能包含凭据的文件；它们不会上传。`;
    this.problem =
      total > 32 * 1024 * 1024
        ? "本批超过 32 MB，请分批选择文档与配图。"
        : this.selection.length > 500
          ? "每批最多 500 个文件，请分批导入。"
          : this.selection.some(
                (item) =>
                  item.file.size >
                  (image.test(item.path) ? 8 : 2) * 1024 * 1024,
              )
            ? "有文件超过限制：正文最大 2 MB，单张图片最大 8 MB。"
            : this.selection.length && !documents
              ? "请同时选择至少一篇 Markdown 或 TXT 文档。仅上传图片请使用编辑器的图片按钮。"
              : "";
    this.showError(this.problem);
    element<HTMLButtonElement>("confirm-import").disabled =
      !documents || Boolean(this.problem) || this.busy;
  }

  private startPreview() {
    if (this.busy || this.problem || !this.selection.length) return;
    const version = ++this.selectionVersion;
    this.preview = undefined;
    element("import-preview").hidden = false;
    element("import-preview").textContent = "正在检查正文、重复路径与配图…";
    element("import-preview").setAttribute("aria-busy", "true");
    element("retry-import-preview").hidden = true;
    this.showError("");
    this.previewTask = (async () => {
      try {
        const result = await previewImport(this.selection);
        if (version !== this.selectionVersion) return;
        this.preview = result;
        this.callbacks.quota(result.quota);
        this.renderPreview(result);
      } catch (error) {
        if (version !== this.selectionVersion) return;
        element("import-preview").textContent = "预检未完成，所选文件仍保留。";
        element("retry-import-preview").hidden = false;
        this.showError(errorMessage(error));
      } finally {
        if (version === this.selectionVersion)
          element("import-preview").setAttribute("aria-busy", "false");
      }
    })();
  }

  private renderPreview(preview: ImportPreview) {
    const area = element("import-preview");
    area.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = "导入前，逐篇确认";
    const intro = document.createElement("p");
    intro.textContent =
      "新文档默认创建草稿，已有文档默认跳过。更新只写入工作副本，线上版本仍需手动发布。";
    area.append(heading, intro);
    const list = document.createElement("div");
    list.className = "import-candidates";
    preview.candidates.forEach((candidate) =>
      list.append(this.candidateRow(candidate)),
    );
    area.append(list);
    if (preview.skipped.length)
      this.lines(
        area,
        preview.skipped.map((item) => `${item.path}：${item.message}`),
      );
    if (preview.unresolvedImages.length) {
      const warning = document.createElement("p");
      warning.className = "import-image-warning";
      warning.textContent = `${preview.unresolvedImages.length} 处配图未匹配，导入后请检查：`;
      area.append(warning);
      this.lines(
        area,
        preview.unresolvedImages.map(
          (item) => `${item.document} → ${item.path}`,
        ),
      );
    }
    if (preview.warnings.length) this.lines(area, preview.warnings);
  }

  private candidateRow(candidate: ImportCandidate): HTMLElement {
    const row = document.createElement("div");
    row.className = "import-candidate";
    row.dataset.importPath = candidate.path;
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = candidate.title || candidate.path;
    const path = document.createElement("code");
    path.textContent = candidate.path;
    const status = document.createElement("span");
    status.className = `candidate-status ${candidate.status}`;
    status.textContent = statusLabels[candidate.status];
    body.append(title, path, status);
    if (candidate.existingId) {
      const existing = document.createElement("small");
      existing.textContent = `已有文档 ${candidate.existingId} · 工作版本 ${candidate.version}`;
      body.append(existing);
    }
    if (candidate.message) {
      const message = document.createElement("small");
      message.textContent = candidate.message;
      body.append(message);
    }
    const choice = document.createElement("select");
    choice.setAttribute("aria-label", `导入操作：${candidate.path}`);
    const options: [ImportAction, string][] = [
      ["skip", "跳过"],
      ["create", "创建新草稿"],
    ];
    if (candidate.existingId && candidate.version)
      options.push(["update", "更新已有工作副本"]);
    options.forEach(([value, label]) => choice.add(new Option(label, value)));
    choice.value =
      this.choices[candidate.path] ||
      (candidate.status === "new" ? "create" : "skip");
    choice.disabled = this.busy || candidate.status === "invalid";
    choice.addEventListener("change", () => {
      this.choices = {
        ...this.choices,
        [candidate.path]: choice.value as ImportAction,
      };
      this.requestId = crypto.randomUUID().replaceAll("-", "");
    });
    row.append(body, choice);
    return row;
  }

  private async submit() {
    if (this.busy || this.problem || !this.selection.length) return;
    this.setBusy(true);
    this.showError("");
    try {
      await this.previewTask;
      if (!this.preview) return;
      const decisions = buildImportDecisions(
        this.preview.candidates,
        this.choices,
      );
      const result = await importDocuments(
        this.selection,
        decisions,
        this.requestId,
      );
      this.callbacks.quota(result.quota);
      this.renderReport(result);
      this.selection = [];
      this.skipped = [];
      this.preview = undefined;
      element("import-preview").hidden = true;
      this.renderSelection();
      await this.callbacks.imported(result);
    } catch (error) {
      this.showError(errorMessage(error));
      // Preserve the selection and decisions on failure. A stale update needs a fresh preflight.
      element("retry-import-preview").hidden = false;
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(value: boolean) {
    this.busy = value;
    element<HTMLButtonElement>("confirm-import").textContent = value
      ? "正在检查并导入…"
      : "导入为草稿 →";
    element<HTMLButtonElement>("confirm-import").disabled =
      value || !this.selection.length || Boolean(this.problem);
    for (const id of [
      "choose-import-files",
      "choose-import-folder",
      "clear-import-selection",
      "close-import",
      "retry-import-preview",
    ])
      element<HTMLButtonElement>(id).disabled = value;
    element("import-preview")
      .querySelectorAll("select")
      .forEach((select) => {
        select.disabled =
          value ||
          select.closest("[data-import-path]")?.querySelector(".invalid") !==
            null;
      });
  }

  private async loadReports() {
    const area = element("import-report-history");
    area.hidden = false;
    area.textContent = "正在读取最近导入报告…";
    try {
      const { reports } = await listImportReports();
      area.replaceChildren();
      if (!reports.length) {
        area.textContent =
          "还没有导入报告。完成首次导入后，可以在这里回看结果。";
        return;
      }
      for (const report of reports) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${new Date(report.createdAt).toLocaleString("zh-CN")} · 新增 ${report.imported.length} 篇 · 更新 ${report.updated?.length || 0} 篇`;
        button.addEventListener("click", () => this.renderReport(report));
        area.append(button);
      }
    } catch (error) {
      area.textContent = errorMessage(error);
    }
  }

  private renderReport(report: SavedImportReport) {
    const area = element("import-report");
    area.hidden = false;
    area.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = report.imported.length
      ? `${report.imported.length} 篇文档已导入为草稿${report.updated?.length ? ` · 更新 ${report.updated.length} 篇` : ""}`
      : report.updated?.length
        ? `工作副本已更新 · 更新 ${report.updated.length} 篇`
        : "本批未写入文档";
    area.append(heading);
    const description = document.createElement("p");
    description.textContent =
      "文档和匹配到的图片已保存到服务器。检查正文与配图后，点击「发布文档」才会出现在阅读空间。";
    area.append(description);
    if (report.skipped.length)
      this.lines(
        area,
        report.skipped.map((item) => `${item.path}：${item.message}`),
      );
    if (report.unresolvedImages.length) {
      const p = document.createElement("p");
      p.textContent = `有 ${report.unresolvedImages.length} 处配图未匹配，请在发布前检查：`;
      area.append(p);
      this.lines(
        area,
        report.unresolvedImages.map(
          (item) => `${item.document} → ${item.path}`,
        ),
      );
    }
    if (report.warnings.length) this.lines(area, report.warnings);
    const affected = [...report.imported, ...(report.updated || [])];
    if (affected.length) {
      const list = document.createElement("div");
      list.className = "import-report-documents";
      affected.forEach((doc) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `打开工作副本：${doc.title} →`;
        button.addEventListener("click", () => {
          this.close();
          void this.callbacks.openDocument(doc.id);
        });
        list.append(button);
      });
      area.append(list);
    }
  }
  private showError(message: string) {
    element("import-error").textContent = message;
    element("import-error").hidden = !message;
  }
  private lines(area: HTMLElement, values: string[]) {
    const list = document.createElement("ul");
    values.forEach((value) => {
      const line = document.createElement("li");
      line.textContent = value;
      list.append(line);
    });
    area.append(list);
  }
}
