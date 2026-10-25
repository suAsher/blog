import { articleUrl, element, getState, loadLibraryIndex, queryPublished, patchEntry, syncBookmarkButtons, toast, usingExamples } from './shared';

const themeButton = document.querySelector<HTMLButtonElement>('[data-theme-toggle]');
function updateThemeLabel() {
  themeButton?.setAttribute('aria-label', `切换到${document.documentElement.dataset.theme === 'dark' ? '浅' : '深'}色主题`);
}
updateThemeLabel();
themeButton?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('asher-theme', next); } catch { toast('主题已切换，此浏览器未允许保存偏好。'); }
  updateThemeLabel();
});

const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]');
logoutButton?.addEventListener('click', async () => {
  if (logoutButton.disabled) return;
  logoutButton.disabled = true;
  try {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Logout unavailable');
    location.replace('/login/?reason=logout');
  } catch {
    toast('暂时无法退出，请检查连接后重试。');
    logoutButton.disabled = false;
  }
});

const dialog = document.querySelector<HTMLDialogElement>('#search-dialog');
const query = document.querySelector<HTMLInputElement>('#quick-search');
const results = document.querySelector<HTMLElement>('#quick-results');
let searchVersion = 0;
let quickTimer: ReturnType<typeof setTimeout>;
let quickRequest: AbortController | undefined;
async function quickSearch() {
  if (!results || !query) return;
  const version = ++searchVersion;
  quickRequest?.abort(); quickRequest = new AbortController();
  const term = query.value.trim();
  if (!term) { results.replaceChildren(element('p', 'search-hint', '输入一个关键词，发现相关的笔记。')); return; }
  results.replaceChildren(element('p', 'search-hint', '正在查找…'));
  try {
    const matches = (await queryPublished(term, '', '', 0, 7, quickRequest.signal)).documents;
    if (version !== searchVersion) return;
    results.replaceChildren();
    if (!matches.length) results.append(element('p', 'search-hint', '没有找到相关内容，试试其他关键词。'));
    matches.forEach(article => {
      const link = element('a', 'search-result'); link.href = articleUrl(article.id);
      const token = term.split(/\s+/)[0].toLocaleLowerCase();
      const at = article.body.toLocaleLowerCase().indexOf(token);
      const excerpt = at >= 0 ? `…${article.body.slice(Math.max(0, at - 30), at + 90).replace(/[#*`>]/g, '')}…` : article.description;
      link.append(element('small', '', article.demo ? '示例文章' : '文章'), element('strong', '', ` ${article.title}`), element('p', '', excerpt)); results.append(link);
    });
    const all = element('a', 'quiet-link mint', '查看全部搜索结果 →');
    all.href = `/articles/?q=${encodeURIComponent(term)}${usingExamples() ? '&examples=1' : ''}`; results.append(all);
  } catch {
    if (version === searchVersion) results.replaceChildren(element('p', 'search-hint', '搜索索引暂时无法加载，请检查连接后重新输入。'));
  }
}
document.querySelector('[data-open-search]')?.addEventListener('click', () => { dialog?.showModal(); query?.focus(); });
document.querySelector('[data-close-search]')?.addEventListener('click', () => dialog?.close());
query?.addEventListener('input', () => { searchVersion++; quickRequest?.abort(); clearTimeout(quickTimer); quickTimer = setTimeout(() => void quickSearch(), 180); });
dialog?.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  }
});
dialog?.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); if (!dialog?.open) dialog?.showModal(); query?.focus();
  }
});
document.addEventListener('click', event => {
  const target = event.target as Element;
  const button = target.closest<HTMLButtonElement>('[data-bookmark]');
  if (button?.dataset.bookmark) {
    const id = button.dataset.bookmark;
    const bookmarked = !getState()[id]?.bookmarked;
    const saved = patchEntry(id, { bookmarked });
    if (saved) toast(bookmarked ? '已放入我的书架' : '已取消收藏');
  }
});
syncBookmarkButtons();

const continueInvitation = document.getElementById('continue-reading')?.cloneNode(true) as HTMLElement | undefined;
async function updateContinueReading() {
  const area = document.getElementById('continue-reading');
  if (!area) return;
  try {
    const state = getState();
    if (!Object.values(state).some(entry => entry.progress > 0 && !entry.read)) {
      if (continueInvitation) area.replaceChildren(...[...continueInvitation.childNodes].map(node => node.cloneNode(true)));
      return;
    }
    const articles = await loadLibraryIndex();
    const article = articles.filter(a => state[a.id]?.progress > 0 && !state[a.id]?.read).sort((a,b) => state[b.id].updatedAt - state[a.id].updatedAt)[0];
    if (!article) {
      if (continueInvitation) area.replaceChildren(...[...continueInvitation.childNodes].map(node => node.cloneNode(true)));
      return;
    }
    const link = element('a', 'quiet-link mint', '接着上次读 →'); link.href = articleUrl(article.id, true);
    area.replaceChildren(element('h3', '', article.title), element('p', '', `上次读到 ${Math.round(state[article.id].progress)}%，让思考继续。`), link);
  } catch { /* Default reading invitation remains usable when the index is unavailable. */ }
}
void updateContinueReading();
document.addEventListener('reading:change', updateContinueReading);
