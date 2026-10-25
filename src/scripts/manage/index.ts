import { formatBytes, jsonRequest, requestJSON, type DocumentDetail, type DocumentList, type DocumentSummary, type ImportReport, type Quota } from '../../lib/documents';
import { DocumentEditor, errorMessage, today } from './editor';
import { DocumentImporter } from './import';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let status = 'all';
let query = '';
let documents: DocumentSummary[] = [];
let total = 0;
let listVersion = 0;
let busy = false;
let searchTimer: ReturnType<typeof setTimeout>;
let refreshTimer: ReturnType<typeof setTimeout>;

function notice(message: string, error = false) { const area = element('workspace-notice'); area.hidden = !message; area.textContent = message; area.classList.toggle('is-error', error); }
function quota(value: Quota) {
  const usable = Math.max(0, value.freeBytes - value.reserveBytes);
  element('storage-status').textContent = `内容已用 ${formatBytes(value.usedBytes)} · 可继续写入约 ${formatBytes(usable)}`;
  element('storage-status').title = `服务器可用 ${formatBytes(value.freeBytes)}，安全预留 ${formatBytes(value.reserveBytes)}。单批上传最多 ${formatBytes(value.maxUploadBytes)}。`;
}
const editor = new DocumentEditor({
  saved: doc => { documents = documents.map(item => item.id === doc.id ? doc : item); renderList(); clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void loadList(), 700); },
  quota, notice,
});
const importer = new DocumentImporter({ quota, imported: async (result: ImportReport) => {
  status = 'draft'; query = ''; element<HTMLInputElement>('manage-search').value = ''; syncTabs(); await loadList();
  if (result.imported[0]) await selectDocument(result.imported[0].id);
} });

function syncTabs() { document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(button => { const active = button.dataset.status === status; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); }
function renderList() {
  const area = element('document-list'); area.replaceChildren();
  documents.forEach(doc => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'document-list-item'; button.dataset.documentId = doc.id;
    button.classList.toggle('active', editor.current?.id === doc.id); button.setAttribute('aria-current', editor.current?.id === doc.id ? 'true' : 'false');
    const title = document.createElement('strong'); title.textContent = doc.title;
    const meta = document.createElement('span'); meta.className = 'document-list-meta';
    const state = document.createElement('span'); state.className = 'document-list-state'; state.textContent = doc.status === 'published' ? '已发布' : doc.status === 'trash' ? '垃圾箱' : '草稿';
    const time = document.createElement('span'); time.textContent = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : doc.date;
    meta.append(state, time);
    if (doc.hasUnpublishedChanges) { const changed = document.createElement('span'); changed.className = 'unpublished-dot'; changed.title = '工作副本有未发布的修改'; meta.append(changed); }
    button.append(title, meta); button.addEventListener('click', () => void selectDocument(doc.id)); area.append(button);
  });
  if (!documents.length) {
    const hint = document.createElement('p'); hint.className = 'list-hint'; hint.textContent = query ? '还没有找到匹配的文档。' : status === 'trash' ? '垃圾箱是空的。' : status === 'published' ? '发布后的文档会出现在这里。' : '还没有文档。从一个想法开始吧。';
    if (!query && status !== 'trash') { const action = document.createElement('button'); action.textContent = '＋ 新建一篇文档'; action.addEventListener('click', () => void createDocument()); hint.append(action); }
    area.append(hint);
  }
  element('document-total').textContent = `${total} 篇`;
  element('load-more-documents').hidden = documents.length >= total;
}
async function loadList(append = false) {
  const version = ++listVersion;
  const params = new URLSearchParams({ status, limit: '60', offset: append ? String(documents.length) : '0' });
  if (query) params.set('q', query);
  try {
    const result = await requestJSON<DocumentList>(`/api/documents?${params}`);
    if (version !== listVersion) return;
    documents = append ? [...documents, ...result.documents] : result.documents; total = result.total;
    element('count-all').textContent = String(result.stats.draft + result.stats.published);
    for (const name of ['draft', 'published', 'trash'] as const) element(`count-${name}`).textContent = String(result.stats[name]);
    quota(result.quota); renderList();
  } catch (error) { if (version === listVersion) { notice(errorMessage(error), true); if (!documents.length) element('document-list').textContent = '文档暂时无法加载，请检查连接后刷新。'; } }
}
async function selectDocument(id: string) {
  if (busy || editor.current?.id === id) return;
  busy = true; editor.lock(true);
  try {
    if (!await editor.flush()) return;
    const doc = await requestJSON<DocumentDetail>(`/api/documents/${encodeURIComponent(id)}`);
    editor.open(doc); renderList();
    history.replaceState(null, '', `/manage/?id=${encodeURIComponent(doc.id)}`);
    if (window.innerWidth <= 620) element('editor-panel').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  } catch (error) { notice(errorMessage(error), true); }
  finally { busy = false; editor.lock(false); }
}
async function createDocument() {
  if (busy) return;
  busy = true; editor.lock(true); const button = element<HTMLButtonElement>('new-document'); button.disabled = true;
  try {
    if (!await editor.flush()) return;
    const doc = await requestJSON<DocumentDetail>('/api/documents', jsonRequest('POST', { title: '未命名文档', description: '', date: today(), tags: [], category: '', cover: '', source: '' }));
    editor.open(doc); status = 'draft'; query = ''; element<HTMLInputElement>('manage-search').value = ''; syncTabs();
    history.replaceState(null, '', `/manage/?id=${doc.id}`); await loadList();
    element<HTMLInputElement>('document-title').focus(); element<HTMLInputElement>('document-title').select(); notice('新文档已创建，接下来的修改会自动保存为草稿。');
  } catch (error) { notice(errorMessage(error), true); }
  finally { busy = false; editor.lock(false); button.disabled = false; }
}
async function openImport() { if (busy || !await editor.flush()) return; importer.open(); }
async function mutate(action: 'publish' | 'unpublish' | 'trash' | 'restore' | 'delete') {
  if (busy || !editor.current) return;
  const title = editor.current.title;
  if (action === 'trash' && !confirm(`将《${title}》移入垃圾箱？之后可以恢复为草稿。`)) return;
  if (action === 'delete' && !confirm(`永久删除《${title}》？此操作不可恢复，请确认已导出需要保留的内容。`)) return;
  busy = true; editor.lock(true);
  const buttons = ['publish-document', 'unpublish-document', 'trash-document', 'restore-document', 'delete-document'].map(id => element<HTMLButtonElement>(id)); buttons.forEach(button => { button.disabled = true; });
  try {
    if (!await editor.flush() || !editor.current) return;
    const doc = editor.current;
    if (action === 'delete') {
      await requestJSON(`/api/documents/${doc.id}`, jsonRequest('DELETE', { version: doc.version }));
      editor.clear(); history.replaceState(null, '', '/manage/'); notice('文档已永久删除。');
    } else {
      const result = await requestJSON<DocumentDetail>(`/api/documents/${doc.id}/${action}`, jsonRequest('POST', { version: doc.version }));
      editor.open(result);
      if (action === 'publish') notice('文档已发布，可以在首页、文章列表和搜索中阅读。');
      if (action === 'unpublish') notice('已撤回发布，文档保留为草稿。');
      if (action === 'trash') { status = 'trash'; notice('文档已移入垃圾箱，仍然可以恢复。'); }
      if (action === 'restore') { status = 'draft'; notice('文档已恢复为草稿，检查后可以重新发布。'); }
      syncTabs();
    }
    await loadList();
  } catch (error) { notice(errorMessage(error), true); }
  finally { busy = false; editor.lock(false); buttons.forEach(button => { button.disabled = false; }); }
}
async function exportDocument(bundle: boolean) {
  if (!editor.current || busy || !await editor.flush()) return;
  const link = document.createElement('a'); link.href = `/api/documents/${editor.current.id}/export${bundle ? '?format=zip' : ''}`;
  link.download = ''; document.body.append(link); link.click(); link.remove();
}

for (const id of ['new-document', 'empty-new-document']) element(id).addEventListener('click', () => void createDocument());
for (const id of ['open-import', 'empty-import']) element(id).addEventListener('click', () => void openImport());
for (const action of ['publish', 'unpublish', 'trash', 'restore', 'delete'] as const) element(`${action}-document`).addEventListener('click', () => void mutate(action));
element('export-markdown').addEventListener('click', () => void exportDocument(false));
element('export-bundle').addEventListener('click', () => void exportDocument(true));
element('load-more-documents').addEventListener('click', () => void loadList(true));
document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach(button => button.addEventListener('click', async () => {
  if (!await editor.flush()) return; status = button.dataset.status || 'all'; syncTabs(); await loadList();
}));
element<HTMLInputElement>('manage-search').addEventListener('input', event => { query = (event.target as HTMLInputElement).value.trim(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void loadList(), 250); });
window.addEventListener('online', () => { notice('连接已恢复，正在尝试保存当前修改。'); void editor.flush(); void loadList(); });
window.addEventListener('offline', () => notice('当前网络已断开。编辑内容保留在本页，恢复连接后会尝试保存。', true));
document.addEventListener('click', event => {
  if (!(event.target instanceof Element) || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const logout = event.target.closest<HTMLButtonElement>('[data-logout]');
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
  const leaving = anchor && !anchor.hasAttribute('download') && anchor.target !== '_blank' &&
    (anchor.origin !== location.origin || anchor.pathname !== location.pathname || anchor.search !== location.search);
  if (!logout && !leaving) return;
  if (busy) { event.preventDefault(); event.stopImmediatePropagation(); notice('正在完成当前操作，请稍候再离开。'); return; }
  if (!editor.hasPendingWork) return;
  event.preventDefault(); event.stopImmediatePropagation();
  void editor.flush().then(saved => { if (saved) { if (logout) logout.click(); else if (anchor) location.assign(anchor.href); } });
}, { capture: true });
void (async () => {
  await loadList();
  const params = new URLSearchParams(location.search), id = params.get('id');
  if (id && /^[a-f0-9]{32}$/.test(id)) await selectDocument(id);
  if (params.get('import') === '1') importer.open();
})();
