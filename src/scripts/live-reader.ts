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
type DocumentLink = { id: string; title: string };
type DocumentLinks = {
  outgoing: DocumentLink[];
  backlinks: DocumentLink[];
  unresolved: { title: string; reason: "missing" | "ambiguous" }[];
  truncated?: boolean;
};
function text(id: string, value: string) { const node = document.getElementById(id); if (node) node.textContent = value; }
function readerLink(item: DocumentLink) {
  const link = element("a", "", item.title);
  link.setAttribute("href", `/articles/${encodeURIComponent(item.id)}/`);
  return link;
}
async function loadKnowledgeLinks(documentId: string) {
  const section = document.getElementById("knowledge-backlinks");
  const status = document.getElementById("backlinks-status");
  const retry = document.getElementById("backlinks-retry");
  if (!section || !status || !retry) return;
  section.hidden = false;
  retry.hidden = true;
  status.hidden = false;
  status.textContent = "正在寻找与这篇文章相连的知识…";
  document.getElementById("backlinks-list")?.replaceChildren();
  document.getElementById("unresolved-links")?.replaceChildren();
  try {
    const links = await requestJSON<DocumentLinks>(
      `/api/documents/${encodeURIComponent(documentId)}/links?view=published`,
    );
    const list = document.getElementById("backlinks-list");
    list?.replaceChildren(...links.backlinks.map(item => {
      const row = document.createElement("li"); row.append(readerLink(item)); return row;
    }));
    status.textContent = links.backlinks.length
      ? links.truncated
        ? `${links.backlinks.length} 篇文章从不同方向连接到这里；仅展示前 300 篇关联文档。`
        : `${links.backlinks.length} 篇文章从不同方向连接到这里。`
      : "还没有其他已发布文章连接到这里。";
    const unresolved = document.getElementById("backlinks-unresolved");
    const unresolvedList = document.getElementById("unresolved-links");
    unresolved?.toggleAttribute("hidden", links.unresolved.length === 0);
    unresolvedList?.replaceChildren(...links.unresolved.map(item => {
      const row = document.createElement("li");
      if (item.reason === "missing") {
        const link = element("a", "", `${item.title} · 新建草稿`);
        link.setAttribute("href", `/manage/?new=1&title=${encodeURIComponent(item.title)}`);
        row.append(link);
      } else row.textContent = `${item.title} · 标题不唯一`;
      return row;
    }));
  } catch {
    status.textContent = "连接暂时无法读取；正文内容不受影响。";
    retry.hidden = false;
  }
}
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
    images.forEach(image => {
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('load', () => window.dispatchEvent(new Event('resize')), { once: true });
      image.addEventListener('error', () => window.dispatchEvent(new Event('resize')), { once: true });
    });
    const cover = document.querySelector<HTMLImageElement>('#live-cover');
    if (cover && data.cover) {
      cover.src = data.cover;
      cover.hidden = false;
    }
    root.hidden = false; if (loading) loading.hidden = true;
    initReader(); syncBookmarkButtons();
    void loadKnowledgeLinks(data.id);
  } catch (error) {
    if (loading) loading.hidden = true;
    if (failure) failure.hidden = false;
    text('reader-error-message', error instanceof ApiError ? error.status === 404 ? '这篇文档尚未发布、已撤回，或地址已经失效。你可以回到文章列表继续探索。' : error.message : '暂时无法读取文档，请检查连接后重试。');
  } finally { inFlight = false; }
}
document.getElementById('reader-retry')?.addEventListener('click', () => void openDocument());
document.getElementById('backlinks-retry')?.addEventListener('click', () => {
  if (root?.dataset.readingArticle) void loadKnowledgeLinks(root.dataset.readingArticle);
});
void openDocument();
