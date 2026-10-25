import { formatBytes, requestJSON, type ImportReport, type Quota } from '../../lib/documents';
import { errorMessage } from './editor';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const allowed = /\.(md|markdown|txt|png|jpe?g|gif|webp)$/i;
const image = /\.(png|jpe?g|gif|webp)$/i;
const unsafe = /(^|\/)(\.[^/]*|node_modules|vendor|id_rsa[^/]*|id_ed25519[^/]*|secrets?)(\/|$)|\.(pem|key|p12|pfx)$/i;
type Selected = { file: File; path: string };

export class DocumentImporter {
  private selection: Selected[] = [];
  private skipped: string[] = [];
  private busy = false;
  private dialog = element<HTMLDialogElement>('import-dialog');
  constructor(private callbacks: { imported: (result: ImportReport) => Promise<void>; quota: (quota: Quota) => void }) {
    element<HTMLInputElement>('import-folder').setAttribute('webkitdirectory', '');
    element('close-import').addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', event => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) { const bounds = this.dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.close(); } });
    for (const kind of ['files', 'folder']) {
      element(`choose-import-${kind}`).addEventListener('click', () => { const input = element<HTMLInputElement>(`import-${kind}`); input.value = ''; input.click(); });
      element<HTMLInputElement>(`import-${kind}`).addEventListener('change', event => this.select([...(event.target as HTMLInputElement).files || []]));
    }
    const dropzone = element('import-dropzone');
    ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
    dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); if (!this.busy) this.select([...(event as DragEvent).dataTransfer?.files || []]); });
    element('clear-import-selection').addEventListener('click', () => { this.selection = []; this.skipped = []; this.renderSelection(); });
    element('confirm-import').addEventListener('click', () => void this.submit());
  }
  open() { if (!this.dialog.open) this.dialog.showModal(); }
  private close() { if (!this.busy) this.dialog.close(); }
  private select(files: File[]) {
    if (this.busy) return;
    const entries = files.map(file => ({ file, path: file.webkitRelativePath || file.name }));
    this.skipped = entries.filter(item => !allowed.test(item.path) || unsafe.test(item.path)).map(item => item.path);
    this.selection = entries.filter(item => allowed.test(item.path) && !unsafe.test(item.path));
    element('import-report').hidden = true; element('import-error').hidden = true; this.renderSelection();
  }
  private renderSelection() {
    const total = this.selection.reduce((sum, item) => sum + item.file.size, 0);
    const documents = this.selection.filter(item => /\.(md|markdown|txt)$/i.test(item.path)).length;
    const images = this.selection.length - documents;
    element('import-selection').hidden = this.selection.length + this.skipped.length === 0;
    element('import-selection-count').textContent = `${documents} 篇文档 · ${images} 张图片`;
    element('import-selection-detail').textContent = `共 ${formatBytes(total)}，导入时保留所选文件夹的相对路径。`;
    const list = element('import-file-list'); list.replaceChildren();
    this.selection.slice(0, 60).forEach(item => { const line = document.createElement('li'); line.textContent = `${item.path} · ${formatBytes(item.file.size)}`; list.append(line); });
    if (this.selection.length > 60) { const line = document.createElement('li'); line.textContent = `另有 ${this.selection.length - 60} 个文件`; list.append(line); }
    element('import-skip-note').hidden = !this.skipped.length;
    element('import-skip-note').textContent = `已跳过 ${this.skipped.length} 个不支持、隐藏或可能包含凭据的文件；它们不会上传。`;
    let problem = '';
    if (total > 32 * 1024 * 1024) problem = '本批超过 32 MB，请分批选择文档与配图。';
    else if (this.selection.length > 500) problem = '每批最多 500 个文件，请分批导入。';
    else if (this.selection.some(item => item.file.size > (image.test(item.path) ? 8 : 2) * 1024 * 1024)) problem = '有文件超过限制：正文最大 2 MB，单张图片最大 8 MB。';
    else if (this.selection.length && !documents) problem = '请同时选择至少一篇 Markdown 或 TXT 文档。仅上传图片请使用编辑器的图片按钮。';
    element('import-error').hidden = !problem; element('import-error').textContent = problem;
    element<HTMLButtonElement>('confirm-import').disabled = !documents || Boolean(problem) || this.busy;
  }
  private async submit() {
    if (this.busy || !this.selection.length) return;
    this.busy = true;
    element('import-error').hidden = true;
    const button = element<HTMLButtonElement>('confirm-import'); button.disabled = true; button.textContent = '正在上传并导入…';
    for (const id of ['choose-import-files', 'choose-import-folder', 'clear-import-selection', 'close-import']) element<HTMLButtonElement>(id).disabled = true;
    const form = new FormData();
    form.append('paths', JSON.stringify(this.selection.map(item => item.path)));
    this.selection.forEach(item => form.append('files', item.file, item.file.name));
    try {
      const result = await requestJSON<ImportReport>('/api/import', { method: 'POST', body: form });
      this.callbacks.quota(result.quota); await this.callbacks.imported(result); this.renderReport(result);
      this.selection = []; this.skipped = []; this.renderSelection();
    } catch (error) { element('import-error').textContent = errorMessage(error); element('import-error').hidden = false; }
    finally {
      this.busy = false; button.textContent = '导入为草稿 →';
      for (const id of ['choose-import-files', 'choose-import-folder', 'clear-import-selection', 'close-import']) element<HTMLButtonElement>(id).disabled = false;
      button.disabled = !this.selection.length;
    }
  }
  private renderReport(report: ImportReport) {
    const area = element('import-report'); area.hidden = false; area.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = `${report.imported.length} 篇文档已导入为草稿`; area.append(heading);
    const description = document.createElement('p'); description.textContent = '文档和匹配到的图片已保存到服务器。检查正文与配图后，点击「发布文档」才会出现在阅读空间。'; area.append(description);
    if (report.skipped.length) { const p = document.createElement('p'); p.textContent = `有 ${report.skipped.length} 个文件未导入：`; area.append(p); this.lines(area, report.skipped.map(item => `${item.path}：${item.message}`)); }
    if (report.unresolvedImages.length) { const p = document.createElement('p'); p.textContent = `有 ${report.unresolvedImages.length} 处配图未匹配，请在发布前检查：`; area.append(p); this.lines(area, report.unresolvedImages.map(item => `${item.document} → ${item.path}`)); }
    if (report.warnings.length) this.lines(area, report.warnings);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '查看导入的草稿 →'; button.addEventListener('click', () => this.close()); area.append(button);
  }
  private lines(area: HTMLElement, values: string[]) { const list = document.createElement('ul'); values.forEach(value => { const line = document.createElement('li'); line.textContent = value; list.append(line); }); area.append(list); }
}
