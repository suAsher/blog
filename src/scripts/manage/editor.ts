import { ApiError, documentHref, jsonRequest, requestJSON, type DocumentContent, type DocumentDetail, type Quota } from '../../lib/documents';
import { commandSnippet, imageValidationMessage, mapSelection, slashCommand, writingCommands, type SelectionRange } from '../../lib/writing-tools';
import { enhanceContent } from '../content-blocks';
import '../../styles/content-blocks.css';

const input = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fields = {
  title: input<HTMLInputElement>('document-title'), description: input<HTMLTextAreaElement>('document-description'),
  tags: input<HTMLInputElement>('document-tags'), category: input<HTMLInputElement>('document-category'),
  date: input<HTMLInputElement>('document-date'), cover: input<HTMLInputElement>('document-cover'),
  source: input<HTMLTextAreaElement>('document-source'),
};
type Callbacks = { saved: (doc: DocumentDetail) => void; quota: (quota: Quota) => void; notice: (message: string, error?: boolean) => void };
type Preview = { html: string; headings: unknown[]; readingMinutes: number };
const draftKey = (id: string) => `asher-unsaved-${id}`;

export class DocumentEditor {
  current: DocumentDetail | null = null;
  private sequence = 0;
  private savedSequence = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<boolean> | undefined;
  private uploading: Promise<boolean> | undefined;
  private conflict = false;
  private locked = false;
  private previewVersion = 0;
  private mode = 'write';
  private imageTarget: 'source' | 'cover' = 'source';
  private imageAnchor: (SelectionRange & { value: string }) | undefined;
  private slashRange: SelectionRange | undefined;
  constructor(private callbacks: Callbacks) {
    Object.values(fields).forEach(field => field.addEventListener('input', () => this.changed()));
    input<HTMLButtonElement>('save-document').addEventListener('click', () => void this.flush());
    input<HTMLButtonElement>('retry-save').addEventListener('click', () => void this.flush());
    input<HTMLButtonElement>('reload-document').addEventListener('click', () => void this.reload());
    input<HTMLButtonElement>('download-local').addEventListener('click', () => this.downloadLocal());
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => this.setMode(button.dataset.mode || 'write')));
    document.querySelectorAll<HTMLButtonElement>('[data-insert]').forEach(button => button.addEventListener('click', () => this.insertFormat(button.dataset.insert || '')));
    input<HTMLButtonElement>('upload-inline-image').addEventListener('click', () => this.chooseImage('source'));
    input<HTMLButtonElement>('upload-cover').addEventListener('click', () => this.chooseImage('cover'));
    input<HTMLInputElement>('editor-image-input').addEventListener('change', event => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) this.startImageUpload(file, this.imageTarget);
    });
    this.setupInsertionMenu(); this.setupImageTransfers();
    input<HTMLButtonElement>('focus-writing').addEventListener('click', () => this.focusWriting());
    window.addEventListener('beforeunload', event => { if (this.dirty || this.uploading) event.preventDefault(); });
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && this.current) { event.preventDefault(); void this.flush(); }
      if (event.key === 'Escape' && !event.isComposing && !document.querySelector('dialog[open]')) {
        if (!input('insert-menu').hidden) { event.preventDefault(); this.closeInsertionMenu(); fields.source.focus(); }
        else if (document.body.classList.contains('writing-focus')) this.focusWriting(false);
      }
    });
  }
  get dirty() { return this.sequence !== this.savedSequence; }
  get hasPendingWork() { return this.dirty || Boolean(this.uploading); }
  get content(): DocumentContent {
    return {
      title: fields.title.value.trim() || '未命名文档', description: fields.description.value.trim(),
      date: fields.date.value, tags: [...new Set(fields.tags.value.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))],
      category: fields.category.value.trim(), cover: fields.cover.value.trim(), source: fields.source.value,
    };
  }
  open(doc: DocumentDetail) {
    clearTimeout(this.saveTimer); clearTimeout(this.previewTimer); ++this.previewVersion;
    this.current = doc; this.sequence = this.savedSequence = 0; this.conflict = false;
    fields.title.value = doc.title; fields.description.value = doc.description || ''; fields.source.value = doc.source || '';
    fields.tags.value = (doc.tags || []).join('，'); fields.category.value = doc.category || ''; fields.date.value = doc.date?.slice(0, 10) || today(); fields.cover.value = doc.cover || '';
    input('editor-empty').hidden = true; input('editor-panel').hidden = false; input('editor-problem').hidden = true;
    const readonly = doc.status === 'trash' || this.locked;
    Object.values(fields).forEach(field => { field.readOnly = readonly; });
    input('editor-panel').classList.toggle('editor-readonly', readonly);
    this.updateChrome(); this.restoreBackup(); this.wordCount();
    if (this.mode !== 'write') void this.preview();
  }
  clear() {
    clearTimeout(this.saveTimer); clearTimeout(this.previewTimer); ++this.previewVersion;
    this.current = null; this.sequence = this.savedSequence = 0; this.conflict = false;
    input('editor-panel').hidden = true; input('editor-empty').hidden = false;
    this.closeInsertionMenu(); this.focusWriting(false);
  }
  lock(value: boolean) {
    this.locked = value;
    const readonly = value || this.current?.status === 'trash';
    input('editor-panel').setAttribute('aria-busy', String(value));
    Object.values(fields).forEach(field => { field.readOnly = Boolean(readonly); });
    input('editor-panel').classList.toggle('editor-readonly', Boolean(readonly));
    document.querySelectorAll<HTMLButtonElement>('#source-toolbar button, #upload-cover').forEach(button => { button.disabled = Boolean(readonly); });
    this.syncImageButtons();
  }
  private syncImageButtons() {
    const disabled = this.locked || Boolean(this.uploading) || this.current?.status === 'trash';
    for (const id of ['upload-inline-image', 'upload-cover']) input<HTMLButtonElement>(id).disabled = Boolean(disabled);
  }
  private updateChrome() {
    const doc = this.current; if (!doc) return;
    const trash = doc.status === 'trash';
    const status = input('document-status'); status.textContent = trash ? '垃圾箱' : doc.status === 'published' ? (doc.hasUnpublishedChanges ? '已发布 · 有新修改' : '已发布') : '草稿';
    status.classList.toggle('published', doc.status === 'published');
    for (const id of ['save-document', 'publish-document', 'trash-document', 'upload-cover', 'upload-inline-image', 'source-toolbar']) input(id).hidden = trash;
    input('restore-document').hidden = !trash; input('delete-document').hidden = !trash;
    input('unpublish-document').hidden = doc.status !== 'published';
    const view = input<HTMLAnchorElement>('view-document'); view.hidden = doc.status !== 'published'; view.href = documentHref(doc.id);
    input('document-updated').textContent = doc.updatedAt ? `上次保存 ${new Date(doc.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '草稿会自动保存到服务器';
    this.saveStatus('所有修改已保存');
  }
  private changed() {
    if (!this.current || this.current.status === 'trash') return;
    if (this.imageAnchor) this.imageAnchor = { ...mapSelection(this.imageAnchor.value, fields.source.value, this.imageAnchor), value: fields.source.value };
    ++this.sequence; this.backup(); this.wordCount();
    this.saveStatus('有未保存的修改', true);
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { if (!this.conflict) void this.flush(); }, 800);
    clearTimeout(this.previewTimer); this.previewTimer = setTimeout(() => { if (this.mode !== 'write') void this.preview(); }, 550);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.saveTimer);
    while (this.uploading) { if (!await this.uploading) return false; }
    if (!this.current || !this.dirty) return true;
    if (this.conflict) return false;
    if (this.saving) return this.saving;
    this.saving = this.saveLoop().finally(() => { this.saving = undefined; });
    return this.saving;
  }
  private async saveLoop(): Promise<boolean> {
    while (this.current && this.dirty) {
      const id = this.current.id, version = this.current.version, sequence = this.sequence, content = this.content;
      this.saveStatus('正在保存…', true);
      try {
        const doc = await requestJSON<DocumentDetail>(`/api/documents/${id}`, jsonRequest('PUT', { ...content, version }));
        if (this.current?.id !== id) return false;
        this.current = doc; this.savedSequence = sequence;
        this.updateChrome(); this.callbacks.saved(doc);
        if (!this.dirty) { this.removeBackup(id); input('editor-problem').hidden = true; }
        else this.backup();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) this.conflict = true;
        this.problem(this.conflict ? '这篇文档已在其他窗口更新。你的修改仍保留在这里，请先下载原文，再重新加载服务器版本。' : errorMessage(error));
        this.saveStatus(this.conflict ? '版本冲突 · 原文已保留' : '保存失败 · 原文已保留', true);
        return false;
      }
    }
    return true;
  }
  private saveStatus(message: string, unsaved = false) { const status = input('save-status'); status.textContent = message; status.classList.toggle('is-unsaved', unsaved); }
  private problem(message: string) {
    input('editor-problem').hidden = false; input('editor-problem-text').textContent = message;
    input('reload-document').hidden = !this.conflict; input('retry-save').hidden = this.conflict;
  }
  private backup() {
    if (!this.current) return;
    try { sessionStorage.setItem(draftKey(this.current.id), JSON.stringify({ content: this.content, version: this.current.version, savedAt: Date.now() })); }
    catch { this.callbacks.notice('浏览器无法备份当前未保存内容，请保持页面打开，并尽快保存或下载原文。', true); }
  }
  private removeBackup(id: string) { try { sessionStorage.removeItem(draftKey(id)); } catch { /* The server copy has already been saved. */ } }
  private restoreBackup() {
    if (!this.current || this.current.status === 'trash') return;
    try {
      const raw = sessionStorage.getItem(draftKey(this.current.id)); if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved?.content || typeof saved.content.source !== 'string' || typeof saved.content.title !== 'string' || !Array.isArray(saved.content.tags)) return;
      const current = this.content;
      if ((Object.keys(current) as (keyof DocumentContent)[]).every(key => JSON.stringify(saved.content[key]) === JSON.stringify(current[key]))) { this.removeBackup(this.current.id); return; }
      for (const name of ['title', 'description', 'category', 'date', 'cover', 'source'] as const) if (typeof saved.content[name] === 'string') fields[name].value = saved.content[name];
      fields.tags.value = saved.content.tags.filter((tag: unknown) => typeof tag === 'string').join('，');
      ++this.sequence;
      this.conflict = saved.version !== this.current.version;
      this.problem(this.conflict ? '已找回本标签页未保存的内容，但服务器版本已变化。请先下载原文，再决定是否重新加载。' : '已找回上次未保存的内容，请检查后保存。');
      this.saveStatus('已恢复未保存内容', true);
    } catch { this.callbacks.notice('本标签页的临时备份无法读取，服务器上的文档仍然可用。', true); }
  }
  private async reload() {
    if (!this.current || !confirm('重新加载会放弃本页未保存修改。请先下载当前原文，确定继续吗？')) return;
    const id = this.current.id;
    try { const doc = await requestJSON<DocumentDetail>(`/api/documents/${id}`); this.removeBackup(id); this.open(doc); this.callbacks.saved(doc); }
    catch (error) { this.problem(errorMessage(error)); }
  }
  private wordCount() {
    input('document-word-count').textContent = `${fields.source.value.replace(/\s/g, '').length.toLocaleString('zh-CN')} 字符`;
    const tags = this.content.tags; input('metadata-summary').textContent = tags.length ? tags.slice(0, 3).map(tag => `#${tag}`).join(' · ') : '标签、日期、分类与封面';
  }
  private setMode(mode: string) {
    this.mode = mode; input('editor-body').dataset.mode = mode;
    input('preview-pane').hidden = mode === 'write';
    input('source-toolbar').hidden = mode === 'preview' || this.current?.status === 'trash';
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => { const selected = button.dataset.mode === mode; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
    if (mode !== 'write') void this.preview();
  }
  private async preview() {
    if (!this.current) return;
    const version = ++this.previewVersion, id = this.current.id;
    input('preview-status').textContent = '正在渲染…';
    try {
      const result = await requestJSON<Preview>('/api/preview', jsonRequest('POST', { source: fields.source.value, documentId: id }));
      if (version !== this.previewVersion || this.current?.id !== id) return;
      input('document-preview').innerHTML = result.html;
      enhanceContent(input('document-preview'));
      input('preview-status').textContent = `约 ${result.readingMinutes} 分钟阅读`;
    } catch (error) { if (version === this.previewVersion) input('preview-status').textContent = errorMessage(error); }
  }
  private insertFormat(kind: string) {
    if (!this.current || this.current.status === 'trash' || this.locked) return;
    const field = fields.source, start = field.selectionStart, end = field.selectionEnd;
    const selected = field.value.slice(start, end);
    const insert = commandSnippet(kind, selected);
    if (!insert) return;
    field.setRangeText(insert, start, end, 'end'); field.focus(); this.changed();
  }
  private focusWriting(enabled = !document.body.classList.contains('writing-focus')) {
    document.body.classList.toggle('writing-focus', enabled);
    const button = input<HTMLButtonElement>('focus-writing'); button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? '退出专注 Esc' : '专注写作';
    if (enabled) input('editor-panel').scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  private setupInsertionMenu() {
    const menu = input('insert-menu'), toggle = input<HTMLButtonElement>('open-insert-menu');
    toggle.addEventListener('click', () => {
      if (!menu.hidden) { this.closeInsertionMenu(); return; }
      this.slashRange = undefined; this.showInsertionMenu(); menu.querySelector<HTMLButtonElement>('button')?.focus();
    });
    fields.source.addEventListener('input', event => {
      if ((event as InputEvent).isComposing || this.locked || this.current?.status === 'trash') return;
      const command = slashCommand(fields.source.value, fields.source.selectionStart, fields.source.selectionEnd);
      if (!command) { this.closeInsertionMenu(); return; }
      this.slashRange = command; this.showInsertionMenu(command.query);
    });
    fields.source.addEventListener('keydown', event => {
      if (menu.hidden || event.isComposing) return;
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'].includes(event.key)) { this.closeInsertionMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const buttons = menu.querySelectorAll<HTMLButtonElement>('button');
        buttons[event.key === 'ArrowDown' ? 0 : buttons.length - 1]?.focus();
      } else if (event.key === 'Enter' && this.slashRange) {
        const first = menu.querySelector<HTMLButtonElement>('button'); if (first) { event.preventDefault(); first.click(); }
      }
    });
    fields.source.addEventListener('click', () => this.closeInsertionMenu());
    menu.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.isComposing) return;
      event.preventDefault(); const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
    document.addEventListener('click', event => { if (event.target instanceof Element && !event.target.closest('.insert-menu-anchor') && event.target !== fields.source) this.closeInsertionMenu(); });
  }
  private showInsertionMenu(query = '') {
    const menu = input('insert-menu'); menu.replaceChildren();
    const matches = writingCommands.filter(command => `${command.label} ${command.hint}`.toLocaleLowerCase().includes(query));
    for (const command of matches) {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      const label = document.createElement('span'); label.textContent = command.label;
      const hint = document.createElement('small'); hint.textContent = command.id;
      button.append(label, hint); button.addEventListener('click', () => {
        if (this.slashRange) fields.source.setSelectionRange(this.slashRange.start, this.slashRange.end);
        this.insertFormat(command.id); this.closeInsertionMenu();
      }); menu.append(button);
    }
    if (!matches.length) { const message = document.createElement('p'); message.textContent = '没有匹配的内容块，继续输入或按 Esc。'; menu.append(message); }
    menu.hidden = false; input('open-insert-menu').setAttribute('aria-expanded', 'true');
  }
  private closeInsertionMenu() { input('insert-menu').hidden = true; input('open-insert-menu').setAttribute('aria-expanded', 'false'); this.slashRange = undefined; }
  private setupImageTransfers() {
    fields.source.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.files || [])]; if (!files.length) return;
      if (files.length !== 1) { this.callbacks.notice('一次可粘贴一张图片，多张图片请使用导入文档。', true); return; }
      if (this.startImageUpload(files[0], 'source')) event.preventDefault();
    });
    fields.source.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); fields.source.classList.add('is-image-dragging'); } });
    fields.source.addEventListener('dragleave', () => fields.source.classList.remove('is-image-dragging'));
    fields.source.addEventListener('drop', event => {
      fields.source.classList.remove('is-image-dragging');
      const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return;
      event.preventDefault();
      if (files.length !== 1) { this.callbacks.notice('一次可插入一张图片，多文件请使用导入文档。', true); return; }
      this.startImageUpload(files[0], 'source');
    });
  }
  private startImageUpload(file: File, target: 'source' | 'cover'): boolean {
    if (!this.current || this.current.status === 'trash' || this.locked) return false;
    if (this.uploading) { this.callbacks.notice('上一张图片仍在上传，请等待完成后再插入。', true); return false; }
    const invalid = imageValidationMessage(file); if (invalid) { this.callbacks.notice(invalid, true); return false; }
    this.closeInsertionMenu();
    this.imageAnchor = target === 'source' ? { value: fields.source.value, start: fields.source.selectionStart, end: fields.source.selectionEnd } : undefined;
    const tracked = this.uploadImage(file, target).finally(() => {
      if (this.uploading === tracked) { this.uploading = undefined; this.imageAnchor = undefined; this.syncImageButtons(); }
    });
    this.uploading = tracked; this.syncImageButtons(); return true;
  }
  private chooseImage(target: 'source' | 'cover') { if (!this.current || this.current.status === 'trash' || this.locked || this.uploading) return; this.imageTarget = target; const file = input<HTMLInputElement>('editor-image-input'); file.value = ''; file.click(); }
  private async uploadImage(file: File, target: 'source' | 'cover'): Promise<boolean> {
    if (!this.current) return false;
    const id = this.current.id, form = new FormData(); form.append('files', file);
    this.callbacks.notice('正在上传图片…');
    try {
      const result = await requestJSON<{ assets: { url: string; name: string; size: number }[]; quota: Quota }>('/api/assets', { method: 'POST', body: form });
      if (this.current?.id !== id || !result.assets[0]) { this.callbacks.notice('图片未能写入当前文档，请重新上传。', true); return false; }
      const asset = result.assets[0];
      if (target === 'cover') fields.cover.value = asset.url;
      else {
        const name = file.name.replace(/[\[\]\n\r]/g, ''), anchor = this.imageAnchor;
        fields.source.setRangeText(`![${name}](${asset.url})`, anchor?.start ?? fields.source.selectionStart, anchor?.end ?? fields.source.selectionEnd, 'preserve');
        this.imageAnchor = undefined;
        if (document.activeElement === input('editor-image-input') || document.activeElement === document.body) fields.source.focus();
      }
      this.changed(); this.callbacks.quota(result.quota); this.callbacks.notice('图片已上传，将随文档一起保存。');
      return true;
    } catch (error) { this.callbacks.notice(errorMessage(error), true); this.saveStatus('图片上传失败 · 请重试', true); return false; }
  }
  downloadLocal() {
    const content = this.content;
    const metadata = ['title', 'description', 'date', 'tags', 'category', 'cover'].map(key => `${key}: ${JSON.stringify(content[key as keyof DocumentContent])}`).join('\n');
    const blob = new Blob([`---\n${metadata}\n---\n\n${content.source}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
    link.download = `${content.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || '未保存文档'}.md`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function errorMessage(error: unknown) { return error instanceof ApiError ? error.message : '操作暂时没有完成，请稍后重试。'; }
export function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
