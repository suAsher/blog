import { getState, patchEntry, toast } from './shared';

export function initReader() {

const root = document.querySelector<HTMLElement>('[data-reading-article]');
const id = root?.dataset.readingArticle || '';
if (!root || !id || root.dataset.readerReady === 'true') return;
root.dataset.readerReady = 'true';
const body = document.getElementById('article-body');
const bar = document.getElementById('reading-progress-bar');
const percent = document.getElementById('reading-percent');
const mark = document.getElementById('mark-read');
const focus = document.getElementById('focus-toggle');
const exit = document.getElementById('exit-focus');
let lastSaved = getState()[id]?.progress || 0;
let progress = 0;
let scrolled = false;
let scheduled = false;
let saveTimer: ReturnType<typeof setTimeout>;

function syncRead() {
  const read = Boolean(getState()[id]?.read);
  mark?.setAttribute('aria-pressed', String(read));
  const label = mark?.querySelector('span'); if (label) label.textContent = read ? '已读 · 撤销' : '标为已读';
}
mark?.addEventListener('click', () => {
  const read = !getState()[id]?.read;
  const saved = patchEntry(id, { read });
  if (saved) toast(read ? '已标记为读过，书架里可以回顾。' : '已撤销已读标记');
});
document.addEventListener('reading:change', syncRead); syncRead();

function toggleFocus(enabled: boolean) {
  const top = body?.getBoundingClientRect().top || 0;
  document.body.classList.toggle('focus-mode', enabled);
  focus?.setAttribute('aria-pressed', String(enabled));
  if (exit) exit.hidden = !enabled;
  if (body && top < 0) window.scrollBy({ top: body.getBoundingClientRect().top - top, behavior: 'instant' });
  if (enabled) exit?.focus({ preventScroll: true }); else focus?.focus({ preventScroll: true });
  updateProgress();
}
focus?.addEventListener('click', () => toggleFocus(!document.body.classList.contains('focus-mode')));
exit?.addEventListener('click', () => toggleFocus(false));
document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (target.closest('input,textarea,select,[contenteditable="true"],dialog[open]') || document.querySelector('dialog[open]')) return;
  if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); toggleFocus(!document.body.classList.contains('focus-mode')); }
  if (event.key === 'Escape' && document.body.classList.contains('focus-mode')) toggleFocus(false);
});

document.querySelectorAll<HTMLPreElement>('.prose pre').forEach(pre => {
  const wrapper = document.createElement('div'); wrapper.className = 'code-container';
  pre.before(wrapper); wrapper.append(pre);
  const copy = document.createElement('button'); copy.className = 'code-copy'; copy.textContent = '复制代码'; copy.setAttribute('aria-label', '复制代码');
  const language = document.createElement('span'); language.className = 'code-language'; language.textContent = pre.dataset.language?.toUpperCase() || 'CODE';
  wrapper.append(language, copy);
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || ''); copy.textContent = '已复制 ✓'; toast('代码已复制'); setTimeout(() => { copy.textContent = '复制代码'; }, 2000); }
    catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(pre); selection?.removeAllRanges(); selection?.addRange(range); toast('已选中代码，请按 Ctrl/Cmd+C 复制。'); }
  });
});
document.querySelectorAll<HTMLTableElement>('.prose table').forEach(table => {
  const wrapper = document.createElement('div'); wrapper.className = 'table-wrap'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '文章表格，可左右滚动'); table.before(wrapper); wrapper.append(table);
});

function saveProgress() {
  if (!scrolled || !id || Math.abs(lastSaved - progress) < .4) return;
  lastSaved = progress; patchEntry(id, { progress });
}
function updateProgress() {
  if (!body) return;
  const top = body.getBoundingClientRect().top + window.scrollY;
  const distance = Math.max(1, body.offsetHeight - window.innerHeight + 100);
  progress = Math.min(100, Math.max(0, (window.scrollY - top + 100) / distance * 100));
  if (bar) bar.style.width = `${progress}%`;
  if (percent) percent.textContent = `${Math.round(progress)}%`;
  document.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(Math.round(progress)));
  const headings = [...body.querySelectorAll<HTMLElement>('h2,h3')];
  const active = [...headings].reverse().find(h => h.getBoundingClientRect().top <= 150) || headings[0];
  document.querySelectorAll<HTMLAnchorElement>('.toc-sidebar nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${active?.id}`));
  scheduled = false;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveProgress, 350);
}
window.addEventListener('scroll', () => { scrolled = true; if (!scheduled) { scheduled = true; requestAnimationFrame(updateProgress); } }, { passive: true });
window.addEventListener('resize', updateProgress);
window.addEventListener('pagehide', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });
function resumeReading() {
  if (!body) return;
  if (new URLSearchParams(location.search).get('resume') === '1' && lastSaved > 0 && !location.hash) {
    const top = body.getBoundingClientRect().top + window.scrollY;
    const distance = Math.max(1, body.offsetHeight - window.innerHeight + 100);
    window.scrollTo({ top: top - 100 + distance * lastSaved / 100, behavior: 'instant' });
    toast(`已回到上次读到的 ${Math.round(lastSaved)}%`);
  }
  updateProgress();
}
if (document.readyState === 'complete') resumeReading(); else window.addEventListener('load', resumeReading, { once: true });

}
initReader();
