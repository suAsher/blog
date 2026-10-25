import { readState, saveState, updateEntry, type ReadingState, type ReadingEntry } from '../lib/storage';
import type { SearchArticle } from '../lib/search';
import { searchArticles, getTags, getCategories } from '../lib/search';
import { ApiError, requestJSON, type DocumentList } from '../lib/documents';

let current = readState();
let indexPromise: Promise<SearchArticle[]> | undefined;
let demoPromise: Promise<SearchArticle[]> | undefined;
let localExamples = false;
export const examplesRequested = () => new URLSearchParams(location.search).get('examples') === '1';
export const usingExamples = () => examplesRequested() || localExamples;
export function loadDemoIndex(): Promise<SearchArticle[]> {
  if (!demoPromise) demoPromise = fetch('/search-index.json').then(async response => {
    if (!response.ok) throw new Error('Example index unavailable');
    return await response.json() as SearchArticle[];
  }).catch(error => { demoPromise = undefined; throw error; });
  return demoPromise;
}
export async function queryPublished(query = '', tag = '', category = '', offset = 0, limit = 24, signal?: AbortSignal): Promise<DocumentList> {
  if (!examplesRequested()) {
    const params = new URLSearchParams({ status: 'published', q: query, tag, category, offset: String(offset), limit: String(limit) });
    try { return await requestJSON<DocumentList>(`/api/documents?${params}`, { signal }); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404 || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw error;
      localExamples = true;
    }
  }
  const all = await loadDemoIndex();
  const matches = searchArticles(all, query, tag, category);
  return {
    documents: matches.slice(offset, offset + limit) as DocumentList['documents'], total: matches.length,
    tags: getTags(all), categories: getCategories(all), stats: { published: all.length, draft: 0, trash: 0 },
    quota: { usedBytes: 0, freeBytes: 0, reserveBytes: 0, maxUploadBytes: 0, maxImageBytes: 0, maxSourceBytes: 0 },
  };
}
let toastTimer: ReturnType<typeof setTimeout>;
export const getState = () => current;
export function toast(message: string) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.add('visible');
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}
let storageWarned = false;
export function replaceState(state: ReadingState) {
  current = state;
  const saved = saveState(current);
  if (!saved && !storageWarned) {
    storageWarned = true;
    toast('浏览器不允许保存记录；本页可用，刷新后可能丢失。');
  }
  document.dispatchEvent(new CustomEvent('reading:change'));
  return saved;
}
export function patchEntry(id: string, patch: Partial<ReadingEntry>) {
  return replaceState(updateEntry(current, id, patch));
}
export function loadIndex() {
  if (!indexPromise) indexPromise = (async () => {
    let articles: SearchArticle[] = [];
    let offset = 0;
    while (true) {
      const page = await queryPublished('', '', '', offset, 1000);
      articles = [...articles, ...page.documents];
      offset += page.documents.length;
      if (offset >= page.total || page.documents.length === 0) return articles;
    }
  })().catch(error => { indexPromise = undefined; throw error; });
  return indexPromise;
}
export async function loadLibraryIndex() {
  const articles = await loadIndex();
  const legacyIds = Object.keys(getState()).filter(id => !/^[a-f0-9]{32}$/.test(id));
  if (!legacyIds.length || usingExamples()) return articles;
  const examples = await loadDemoIndex();
  return [...articles, ...examples.filter(article => legacyIds.includes(article.id) && !articles.some(item => item.id === article.id))];
}
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
export function articleUrl(id: string, resume = false) {
  return `/articles/${id.split('/').map(encodeURIComponent).join('/')}/${resume ? '?resume=1' : ''}`;
}
export function syncBookmarkButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-bookmark]').forEach(button => {
    const saved = Boolean(current[button.dataset.bookmark || '']?.bookmarked);
    button.setAttribute('aria-pressed', String(saved));
    const label = button.getAttribute('aria-label') || '';
    button.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'}：${label.split('：').slice(1).join('：')}`);
    const text = button.querySelector('[data-bookmark-label]');
    if (text) text.textContent = saved ? '已收藏' : '收藏';
  });
}
export function makeCard(article: SearchArticle, resume = false, library = true) {
  const card = element('article', library ? 'article-card library-card' : 'article-card');
  const cover = element('a', 'card-cover');
  cover.href = articleUrl(article.id, resume);
  cover.tabIndex = -1;
  cover.setAttribute('aria-hidden', 'true');
  const image = element('img');
  image.src = article.cover || '/images/orbit.svg'; image.alt = ''; image.width = 600; image.height = 340;
  image.loading = 'lazy'; cover.append(image);
  const content = element('div', 'card-content');
  card.dataset.articleCard = article.id;
  const meta = element('div', 'card-meta');
  meta.append(element('span', 'demo-mark', article.demo ? '示例文章' : '文章'), element('span', '', `${article.readingMinutes} 分钟阅读`));
  const heading = element('h3');
  const link = element('a', '', article.title); link.href = articleUrl(article.id, resume); heading.append(link);
  const bottom = element('div', 'card-bottom');
  const time = element('time', '', article.date.replaceAll('-', '.')); time.dateTime = article.date;
  const bookmark = element('button', 'icon-button bookmark-button', '◇');
  bookmark.dataset.bookmark = article.id; bookmark.setAttribute('aria-label', `收藏：${article.title}`);
  bottom.append(time, bookmark);
  content.append(meta, heading, element('p', '', article.description));
  const entry = current[article.id];
  if (entry) {
    content.append(element('div', 'library-badge', entry.read ? '✓ 已读' : `已读至 ${Math.round(entry.progress)}%`));
    const meter = element('div', 'resume-meter'); const fill = element('span'); fill.style.width = `${entry.progress}%`; meter.append(fill); content.append(meter);
  }
  content.append(bottom); card.append(cover, content); return card;
}
window.addEventListener('storage', () => { current = readState(); document.dispatchEvent(new CustomEvent('reading:change')); });
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  indexPromise = undefined;
  current = readState();
  document.dispatchEvent(new CustomEvent('reading:change'));
});
document.addEventListener('reading:change', syncBookmarkButtons);
