import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import { ApiError, requestJSON, type DocumentDetail } from '../lib/documents';
import { element, syncBookmarkButtons } from './shared';
import { initReader } from './reader';

for (const [name, language] of Object.entries({ javascript, typescript, json, bash, python, go, yaml, xml, css, sql })) hljs.registerLanguage(name, language);
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'shell'], { languageName: 'bash' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
const root = document.getElementById('live-reader');
const loading = document.getElementById('reader-loading');
const failure = document.getElementById('reader-error');
const id = /^\/articles\/([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1] || new URLSearchParams(location.search).get('id') || '';
let inFlight = false;
function text(id: string, value: string) { const node = document.getElementById(id); if (node) node.textContent = value; }
function toc(data: DocumentDetail) {
  const headings = (data.headings || []).filter(item => item.depth === 2 || item.depth === 3);
  for (const target of ['live-toc', 'live-mobile-toc']) {
    document.getElementById(target)?.replaceChildren(...headings.map(item => {
      const link = element('a', item.depth === 3 ? 'toc-sub' : '', item.text); link.setAttribute('href', `#${item.slug}`); return link;
    }));
  }
  const mobile = document.querySelector<HTMLElement>('.mobile-toc'); if (mobile) mobile.hidden = headings.length === 0;
  if (!headings.length) document.getElementById('live-toc')?.append(element('p', 'sidebar-note', '这篇笔记适合一口气读完。'));
}
async function openDocument() {
  if (inFlight || !root) return;
  inFlight = true; if (loading) loading.hidden = false; if (failure) failure.hidden = true;
  try {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError('文档地址无效，请从文章列表重新打开。', 404);
    const data = await requestJSON<DocumentDetail>(`/api/documents/${id}?view=published`);
    document.title = `${data.title} · asher 知识空间`;
    root.dataset.readingArticle = data.id;
    text('live-title', data.title); document.getElementById('live-title')?.setAttribute('aria-label', data.title);
    text('live-description', data.description); text('live-category', data.category || '文章');
    const date = document.querySelector<HTMLTimeElement>('#live-date'); if (date) { date.textContent = data.date.replaceAll('-', '.'); date.dateTime = data.date; }
    text('live-minutes', String(data.readingMinutes));
    const edit = document.querySelector<HTMLAnchorElement>('#live-edit'); if (edit) edit.href = `/manage/?id=${encodeURIComponent(data.id)}`;
    const bookmark = document.getElementById('live-bookmark'); if (bookmark) { bookmark.dataset.bookmark = data.id; bookmark.setAttribute('aria-label', `收藏：${data.title}`); }
    document.getElementById('live-tags')?.replaceChildren(...data.tags.map(tag => {
      const link = element('a', '', `#${tag}`); link.href = `/articles/?tag=${encodeURIComponent(tag)}`; return link;
    }));
    const body = document.getElementById('article-body');
    if (!body) return;
    // The authenticated API renders Markdown with unsafe HTML disabled. Content
    // never goes through an arbitrary client-side Markdown/HTML interpreter.
    body.innerHTML = data.html;
    body.querySelectorAll<HTMLElement>('pre code').forEach(code => {
      const language = /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1] || 'text';
      if (code.parentElement) code.parentElement.dataset.language = language;
      if ((code.textContent?.length || 0) <= 100_000 && hljs.getLanguage(language)) hljs.highlightElement(code);
    });
    toc(data);
    const images = [...body.querySelectorAll<HTMLImageElement>('img')];
    await Promise.race([Promise.all(images.map(image => image.decode().catch(() => undefined))), new Promise(resolve => setTimeout(resolve, 1800))]);
    root.hidden = false; if (loading) loading.hidden = true;
    initReader(); syncBookmarkButtons();
    images.forEach(image => image.addEventListener('load', () => window.dispatchEvent(new Event('resize')), { once: true }));
  } catch (error) {
    if (loading) loading.hidden = true;
    if (failure) failure.hidden = false;
    text('reader-error-message', error instanceof ApiError ? error.status === 404 ? '这篇文档尚未发布、已撤回，或地址已经失效。你可以回到文章列表继续探索。' : error.message : '暂时无法读取文档，请检查连接后重试。');
  } finally { inFlight = false; }
}
document.getElementById('reader-retry')?.addEventListener('click', () => void openDocument());
void openDocument();
