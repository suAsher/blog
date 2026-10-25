import { element, examplesRequested, makeCard, queryPublished, syncBookmarkButtons, usingExamples } from './shared';
import type { DocumentList } from '../lib/documents';

const query = document.querySelector<HTMLInputElement>('#article-query');
const category = document.querySelector<HTMLSelectElement>('#category-filter');
const tagsArea = document.getElementById('article-tags');
const container = document.getElementById('article-results');
const count = document.getElementById('result-count');
const empty = document.getElementById('article-empty');
const reset = document.getElementById('reset-filters');
const more = document.querySelector<HTMLButtonElement>('#article-load-more');
let tag = ''; let selectedCategory = ''; let version = 0; let offset = 0; let total = 0; let facetsReady = false;
let failed = false;
let request: AbortController | undefined; let searchTimer: ReturnType<typeof setTimeout>;
function readURL() {
  const params = new URLSearchParams(location.search);
  if (query) query.value = params.get('q') || '';
  selectedCategory = params.get('category') || '';
  if (category) category.value = selectedCategory;
  tag = params.get('tag') || '';
}
function writeURL() {
  const params = new URLSearchParams();
  if (query?.value.trim()) params.set('q', query.value.trim());
  if (tag) params.set('tag', tag);
  if (selectedCategory) params.set('category', selectedCategory);
  if (examplesRequested()) params.set('examples', '1');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}
function updateActiveTags() {
  tagsArea?.querySelectorAll<HTMLButtonElement>('[data-tag]').forEach(button => {
    const active = button.dataset.tag === tag; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
}
function renderFacets(data: DocumentList) {
  const facets = [{ name: '', count: data.stats.published }, ...(data.tags || [])];
  tagsArea?.replaceChildren(...facets.map(facet => {
    const button = element('button', 'tag-filter', `${facet.name || '全部'} `); button.type = 'button'; button.dataset.tag = facet.name;
    button.append(element('span', '', String(facet.count))); return button;
  }));
  if (category) {
    const selected = selectedCategory;
    const options = [new Option('全部分类', ''), ...(data.categories || []).map(item => new Option(`${item.name} (${item.count})`, item.name))];
    if (selected && !options.some(item => item.value === selected)) options.push(new Option(selected, selected));
    category.replaceChildren(...options); category.value = selected;
  }
  facetsReady = true; updateActiveTags();
}
function setEmpty(visible: boolean, error = false) {
  failed = error;
  if (!empty) return;
  empty.hidden = !visible;
  const filtered = Boolean(query?.value.trim() || tag || selectedCategory);
  const title = empty.querySelector('h2'); const hint = empty.querySelector('p');
  if (title) title.textContent = error ? '暂时无法读取文章' : filtered ? '还没有找到这片叶子' : '第一篇文档，等你写下';
  if (hint) hint.textContent = error ? '请检查连接后再试。已保存的文档不会因此丢失。' : filtered ? '换一个关键词，或放下筛选条件，再探索一次。' : '在写作空间发布文章，或导入已有的 Markdown 文档。';
  if (reset) { reset.hidden = !filtered && !error; reset.textContent = error ? '重新读取文章' : '清除搜索与筛选'; }
  const actions = empty.querySelector<HTMLElement>('.empty-writing-actions'); if (actions) actions.hidden = error || filtered;
}
async function filter(write = true, append = false) {
  if (write) writeURL();
  updateActiveTags();
  const current = ++version;
  request?.abort(); request = new AbortController();
  if (!append) offset = 0;
  if (more) more.disabled = true;
  container?.setAttribute('aria-busy', 'true');
  try {
    const data = await queryPublished(query?.value.trim() || '', tag, selectedCategory, offset, 24, request.signal);
    if (current !== version) return;
    if (!facetsReady) renderFacets(data);
    if (!append) container?.replaceChildren();
    container?.append(...data.documents.map(article => makeCard(article, false, false)));
    offset += data.documents.length; total = data.total;
    if (count) count.textContent = `共 ${total} 篇文章${query?.value.trim() ? ` · “${query.value.trim()}”` : ''}${tag ? ` · #${tag}` : ''}`;
    setEmpty(total === 0);
    if (more) { more.hidden = offset >= total; more.disabled = false; }
    const example = usingExamples();
    const disclaimer = document.getElementById('collection-disclaimer'); if (disclaimer) disclaimer.hidden = !example;
    const source = document.querySelector<HTMLAnchorElement>('#collection-source-link'); if (source && example) { source.textContent = '返回正式内容'; source.href = '/articles/'; }
    syncBookmarkButtons();
    container?.removeAttribute('aria-busy');
  } catch (error) {
    if (current !== version || error instanceof DOMException && error.name === 'AbortError') return;
    if (!append) container?.replaceChildren();
    if (count) count.textContent = '读取失败，请重试。';
    if (more) { more.disabled = false; more.hidden = true; }
    setEmpty(true, true);
    container?.removeAttribute('aria-busy');
  }
}
document.getElementById('article-search-form')?.addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); void filter(); });
query?.addEventListener('input', () => { version++; request?.abort(); writeURL(); clearTimeout(searchTimer); searchTimer = setTimeout(() => void filter(false), 220); });
category?.addEventListener('change', () => { selectedCategory = category.value; void filter(); });
tagsArea?.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLButtonElement>('[data-tag]'); if (button) { tag = button.dataset.tag || ''; void filter(); } });
reset?.addEventListener('click', () => { if (failed) { void filter(false); return; } if (query) query.value = ''; if (category) category.value = ''; selectedCategory = ''; tag = ''; void filter(); query?.focus(); });
more?.addEventListener('click', () => void filter(false, true));
window.addEventListener('popstate', () => { readURL(); void filter(false); });
window.addEventListener('pageshow', event => { if (event.persisted) { readURL(); void filter(false); } });
readURL(); void filter(false);
