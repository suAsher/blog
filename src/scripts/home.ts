import type { SearchArticle } from '../lib/search';
import { articleUrl, element, makeCard, queryPublished, syncBookmarkButtons, usingExamples } from './shared';

const area = document.getElementById('home-featured');
function featuredCard(article: SearchArticle) {
  const card = element('article', 'featured-card');
  const cover = element('a', 'featured-image'); cover.href = articleUrl(article.id); cover.tabIndex = -1; cover.setAttribute('aria-hidden', 'true');
  const image = element('img'); image.src = article.cover || '/images/orbit.svg'; image.alt = ''; image.width = 600; image.height = 500;
  cover.append(image, element('span', 'image-corner mono', 'FIELD NOTES / 001'));
  const content = element('div', 'featured-copy');
  content.append(element('div', 'featured-label', article.demo ? '✧ 示例阅读 · 演示内容' : '✧ 最近发布'));
  const title = element('h3'); const link = element('a', '', article.title); link.href = articleUrl(article.id); title.append(link); content.append(title, element('p', '', article.description));
  const tags = element('div', 'tag-row');
  article.tags.slice(0, 2).forEach(tag => { const a = element('a', '', `#${tag}`); a.href = `/articles/?tag=${encodeURIComponent(tag)}${usingExamples() ? '&examples=1' : ''}`; tags.append(a); });
  const bottom = element('div', 'featured-bottom'); const read = element('a', 'round-link', '→'); read.href = articleUrl(article.id); read.setAttribute('aria-label', `阅读：${article.title}`);
  bottom.append(element('span', '', `${article.date.replaceAll('-', '.')} · ${article.readingMinutes} 分钟`), read);
  content.append(tags, bottom); card.append(cover, content); return card;
}
function invitation(error = false) {
  const box = element('div', 'home-invitation');
  box.append(element('span', 'eyebrow', error ? 'LET’S TRY AGAIN' : 'YOUR FIRST CONNECTION'), element('span', 'invitation-star', '✧'), element('h3', '', error ? '花园暂时没有打开' : '从第一篇文档，开始生长。'), element('p', '', error ? '暂时无法读取文档，请检查连接后重试。' : '写下一个想法，或把已有的 Markdown 与配图带进来。发布后，它会出现在这里。'));
  const actions = element('div', 'invitation-actions');
  if (error) { const retry = element('button', 'button button-primary', '重新读取'); retry.addEventListener('click', () => void renderHome()); actions.append(retry); }
  else { const write = element('a', 'button button-primary', '开始写作 →'); write.href = '/manage/'; const upload = element('a', 'quiet-link', '导入文档 ↗'); upload.href = '/manage/?import=1'; actions.append(write, upload); }
  box.append(actions); return box;
}
async function renderHome() {
  if (!area) return;
  try {
    const data = await queryPublished('', '', '', 0, 4);
    const example = usingExamples();
    const count = document.getElementById('home-document-count'); if (count) count.textContent = `${data.total} 篇${example ? '示例笔记' : '已发布笔记'}`;
    const tags = document.getElementById('home-tag-count'); if (tags) tags.textContent = `${data.tags.length} 个探索标签`;
    const exampleLink = document.querySelector<HTMLAnchorElement>('#home-example-link'); if (exampleLink && example) { exampleLink.textContent = '当前为演示内容 · 返回正式内容'; exampleLink.href = '/'; }
    area.replaceChildren(data.documents.length ? featuredCard(data.documents[0]) : invitation());
    const latest = document.getElementById('home-latest'); latest?.replaceChildren(...data.documents.slice(1).map(item => makeCard(item, false, false)));
    const section = document.getElementById('home-latest-section'); if (section) section.hidden = data.documents.length < 2;
    syncBookmarkButtons();
  } catch {
    area.replaceChildren(invitation(true));
    const count = document.getElementById('home-document-count'); if (count) count.textContent = '文档暂时不可用';
  }
}
void renderHome();
window.addEventListener('pageshow', event => { if (event.persisted) void renderHome(); });
