import { parseState } from '../lib/storage';
import { getState, loadLibraryIndex, makeCard, replaceState, syncBookmarkButtons, toast, element } from './shared';

let tab = 'bookmarked';
const area = document.getElementById('library-results');
const empty = document.getElementById('library-empty');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-library-tab]')];
async function renderLibrary() {
  try {
    const articles = await loadLibraryIndex();
    const state = getState();
    const selected = articles.filter(a => {
      const entry = state[a.id];
      return entry && (tab === 'continue' ? entry.progress > 0 && !entry.read : tab === 'read' ? entry.read : entry.bookmarked);
    }).sort((a, b) => state[b.id].updatedAt - state[a.id].updatedAt);
    area?.replaceChildren(...selected.map(a => makeCard(a, tab === 'continue')));
    if (empty) empty.hidden = selected.length > 0;
    const title = empty?.querySelector('h2'); const hint = empty?.querySelector('p');
    if (title) title.textContent = tab === 'continue' ? '下一次阅读，从这里继续' : tab === 'read' ? '每一次读完，都算一次成长' : '书架空着，好奇心没有';
    if (hint) hint.textContent = tab === 'continue' ? '打开文章开始阅读，进度会自动记录。' : tab === 'read' ? '在文章页点击“标为已读”，就能在这里回顾。' : '点击文章上的收藏图标，把值得重读的内容留在这里。';
    syncBookmarkButtons();
  } catch {
    area?.replaceChildren(element('p', 'search-hint', '文章索引加载失败，请刷新重试。你的本地阅读记录仍然保留。'));
    if (empty) empty.hidden = true;
  }
}
tabs.forEach(button => button.addEventListener('click', () => {
  tab = button.dataset.libraryTab || 'bookmarked';
  tabs.forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  void renderLibrary();
}));
document.getElementById('export-reading')?.addEventListener('click', () => {
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries: getState() }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `asher-reading-${new Date().toISOString().slice(0,10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('已导出阅读记录，可以在另一设备手动导入。');
});
document.getElementById('import-reading')?.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0]; if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error('文件过大');
    const data = JSON.parse(await file.text());
    if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('格式错误');
    const entries = parseState(JSON.stringify(data.entries));
    if (Object.keys(entries).length !== Object.keys(data.entries).length) throw new Error('记录无效');
    const saved = replaceState({ ...getState(), ...entries });
    if (saved) toast(`已导入 ${Object.keys(entries).length} 条记录，已合并到本机；联网后同步，冲突请在页脚选择。`);
  } catch { toast('无法导入：请选择有效的 asher 阅读记录 JSON 文件（小于 2 MB）。'); }
  input.value = '';
});
document.addEventListener('reading:change', renderLibrary);
void renderLibrary();
