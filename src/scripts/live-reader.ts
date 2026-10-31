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
import { initEditorialReader } from './editorial-reader';
import { initLearningNavigation } from './learning-reader';
import { initAnnotations } from './annotations';
import { projectPublishedSnapshot } from '../lib/offline-snapshot';
import { waitForOfflineShellReady } from '../lib/pwa-readiness';
import { saveSnapshot, unlockVault, vaultExists, vaultUnlocked } from '../lib/offline-vault';

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
let publishedDocument: DocumentDetail | undefined;
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
function offlineSaveDialog() {
  let dialog = document.querySelector<HTMLDialogElement>('#offline-save-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'offline-save-dialog';
  dialog.className = 'device-dialog offline-save-dialog';
  dialog.setAttribute('aria-labelledby', 'offline-save-title');
  dialog.innerHTML = `<form method="dialog"><h2 id="offline-save-title">加密保存到此设备</h2><p>请使用独立于站点登录密码的离线口令。口令只留在内存中，刷新或离开页面后需要重新输入。</p><label for="reader-offline-passphrase">离线口令</label><input id="reader-offline-passphrase" type="password" minlength="10" maxlength="1024" autocomplete="off" required><label id="reader-offline-confirm-row" for="reader-offline-confirm">再次输入离线口令</label><input id="reader-offline-confirm" type="password" minlength="10" maxlength="1024" autocomplete="off"><label id="reader-offline-consent-row" class="consent"><input id="reader-offline-consent" type="checkbox"> 我知道离线时无法发现远端撤回或删除；恢复联网后会验证版本，7 天期限依赖设备时钟。</label><p id="reader-offline-error" class="form-error" role="alert" hidden></p><div><button value="cancel" class="button">取消</button><button id="reader-offline-confirm-save" value="save" class="button button-primary">加密保存</button></div></form>`;
  document.body.append(dialog);
  return dialog;
}
async function savePublishedOffline() {
  if (!publishedDocument) return;
  const button = document.querySelector<HTMLButtonElement>('#save-offline-document');
  const dialog = offlineSaveDialog();
  const exists = await vaultExists();
  const password = dialog.querySelector<HTMLInputElement>('#reader-offline-passphrase')!;
  const passwordRow = dialog.querySelector<HTMLElement>('label[for="reader-offline-passphrase"]')!;
  const confirm = dialog.querySelector<HTMLInputElement>('#reader-offline-confirm')!;
  const confirmRow = dialog.querySelector<HTMLElement>('#reader-offline-confirm-row')!;
  const consent = dialog.querySelector<HTMLInputElement>('#reader-offline-consent')!;
  const consentRow = dialog.querySelector<HTMLElement>('#reader-offline-consent-row')!;
  const failure = dialog.querySelector<HTMLElement>('#reader-offline-error')!;
  password.hidden = false; passwordRow.hidden = false; password.required = true;
  confirm.hidden = exists; confirmRow.hidden = exists; consentRow.hidden = exists;
  confirm.required = !exists; consent.required = !exists;
  while (!vaultUnlocked()) {
    dialog.returnValue = '';
    dialog.showModal();
    const result = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (result !== 'save') return;
    failure.hidden = true;
    try {
      if (!exists && password.value !== confirm.value) throw new Error('两次输入的离线口令不一致。');
      if (!exists && !consent.checked) throw new Error('请先确认离线撤回与设备时钟限制。');
      await unlockVault(password.value, !exists);
    } catch (error) {
      failure.textContent = error instanceof Error ? error.message : '无法解锁离线资料。';
      failure.hidden = false;
      password.value = ''; confirm.value = '';
      continue;
    } finally { password.value = ''; confirm.value = ''; }
  }
  if (button) { button.disabled = true; button.querySelector('span')!.textContent = '正在加密…'; }
  try {
    while (true) {
      try {
        const snapshot = await projectPublishedSnapshot(publishedDocument);
        await waitForOfflineShellReady();
        await saveSnapshot(snapshot);
        if (button) button.querySelector('span')!.textContent = '已保存离线';
        return;
      } catch (error) {
        if (button) button.querySelector('span')!.textContent = '保存离线';
        failure.textContent = error instanceof Error ? error.message : '暂时无法保存离线资料。';
        failure.hidden = false;
        password.hidden = true; passwordRow.hidden = true; password.required = false;
        confirm.hidden = true; confirmRow.hidden = true; confirm.required = false;
        consentRow.hidden = true; consent.required = false;
        dialog.returnValue = '';
        dialog.showModal();
        const result = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
        if (result !== 'save') return;
        failure.hidden = true;
        if (button) button.querySelector('span')!.textContent = '正在加密…';
      }
    }
  } finally { if (button) button.disabled = false; }
}
function enableOfflineSave(data: DocumentDetail) {
  publishedDocument = data;
  const actions = document.querySelector('.reader-toolbar > div');
  if (!actions || document.getElementById('save-offline-document')) return;
  const save = element('button', 'reader-tool');
  save.id = 'save-offline-document'; save.type = 'button';
  save.innerHTML = '<span>保存离线</span>';
  save.addEventListener('click', () => void savePublishedOffline().catch(error => {
    const dialog = offlineSaveDialog();
    const failure = dialog.querySelector<HTMLElement>('#reader-offline-error')!;
    failure.textContent = error instanceof Error ? error.message : '此浏览器暂时无法使用离线资料。';
    failure.hidden = false;
    if (!dialog.open) dialog.showModal();
  }));
  actions.append(save);
}
async function openDocument() {
  if (inFlight || !root) return;
  inFlight = true; if (loading) loading.hidden = false; if (failure) failure.hidden = true;
  try {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new ApiError('文档地址无效，请从文章列表重新打开。', 404);
    const data = await requestJSON<DocumentDetail>(`/api/documents/${id}?view=published`);
    enableOfflineSave(data);
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
    initReader(); initEditorialReader(data, body); syncBookmarkButtons();
    void initLearningNavigation(data.id);
    void initAnnotations(data.id, data.version);
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
