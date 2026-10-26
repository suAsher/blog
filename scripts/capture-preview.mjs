/** Capture generated example content only. Credentials never enter screenshots or reports. */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readLocalCredentials } from './local-private-server.mjs';

const mode = process.env.BLOG_CAPTURE_MODE || 'examples';
if (!['examples', 'today'].includes(mode)) throw new Error('Capture mode must be examples or today.');
if (mode === 'today' && process.env.BLOG_TEST_LOCAL_AUTH !== '1') throw new Error('Today captures require temporary local QA authentication.');

async function seedToday(request, origin, record) {
  const day = new Date().toISOString().slice(0, 10);
  const anniversary = `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
  let documents = [];
  for (const [title, kind, maturity, published, date] of [
    ['QA · 从一个问题，走向一张知识地图', 'article', 'evergreen', true, day],
    ['QA · 去年今天：给理解留下一条线索', 'article', 'growing', true, anniversary],
    ['QA · 今天捕捉的一个好问题', 'note', 'growing', false, day],
    ['QA · 等待整理的一页笔记', 'article', '', false, day],
  ]) {
    const response = await request.post('/api/documents', { headers: { Origin: origin }, data: {
      title, description: '只为本次本地界面验收生成的示例内容。', date, tags: ['QA示例'], category: '临时验收',
      cover: '', source: `## 从一个问题开始\n\n${'记录一个观察，保留继续探索的线索。'.repeat(24)}`, kind, maturity, series: 'QA日常观察', related: [],
    } });
    if (!response.ok()) throw new Error('QA Today dataset creation failed.');
    let { data } = await response.json();
    documents = [...documents, data];
    record(data);
    if (published) {
      const response = await request.post(`/api/documents/${data.id}/publish`, { headers: { Origin: origin }, data: { version: data.version } });
      if (!response.ok()) throw new Error('QA Today dataset publication failed.');
      ({ data } = await response.json());
      documents = [...documents.slice(0, -1), data];
      record(data);
    }
  }
  return documents;
}

async function cleanupToday(request, origin, documents) {
  for (let document of documents) {
    if (document.status !== 'trash') {
      const response = await request.post(`/api/documents/${document.id}/trash`, { headers: { Origin: origin }, data: { version: document.version } });
      if (!response.ok()) throw new Error('QA Today cleanup failed.');
      ({ data: document } = await response.json());
    }
    const response = await request.delete(`/api/documents/${document.id}`, { headers: { Origin: origin }, data: { version: document.version } });
    if (!response.ok()) throw new Error('QA Today cleanup failed.');
  }
}

const base = new URL(process.env.BLOG_CAPTURE_BASE_URL || 'http://127.0.0.1:4321');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Capture base must be an HTTP(S) origin.');
const themes = (process.env.BLOG_CAPTURE_THEMES || 'dark,light').split(',');
const allowed = { desktop: { width: 1440, height: 1000 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } };
const viewports = (process.env.BLOG_CAPTURE_VIEWPORTS || 'desktop,tablet,mobile').split(',');
if (themes.some(theme => !['dark', 'light'].includes(theme)) || viewports.some(name => !allowed[name])) throw new Error('Invalid capture theme or viewport.');
const output = resolve(process.env.BLOG_CAPTURE_OUTPUT || 'docs/qa/previews');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
let captures = 0;
let seedContext;
let owned = [];
try {
  if (mode === 'today') {
    seedContext = await browser.newContext({ baseURL: base.origin, ignoreHTTPSErrors: true });
    const credentials = await readLocalCredentials(base.origin);
    const response = await seedContext.request.post('/auth/login', { headers: { Origin: base.origin }, data: { username: credentials.username, password: credentials.password } });
    if (!response.ok()) throw new Error('Local QA capture login failed.');
    owned = await seedToday(seedContext.request, base.origin, document => { owned = [...owned.filter(item => item.id !== document.id), document]; });
  }
  for (const name of viewports) {
    const context = await browser.newContext({ viewport: allowed[name], deviceScaleFactor: 1, baseURL: base.origin, ignoreHTTPSErrors: process.env.BLOG_TEST_LOCAL_AUTH === '1', reducedMotion: 'reduce' });
    if (process.env.BLOG_TEST_LOCAL_AUTH === '1') {
      const credentials = await readLocalCredentials(base.origin);
      const response = await context.request.post('/auth/login', { headers: { Origin: base.origin }, data: { username: credentials.username, password: credentials.password } });
      if (response.status() !== 200) throw new Error('Local capture login failed.');
    }
    for (const theme of themes) {
      await context.addInitScript(value => localStorage.setItem('asher-theme', value), theme);
      const page = await context.newPage();
      // Today mode uses only documents generated above in the temporary local QA store.
      const paths = mode === 'today' ? [['today', '/'], ['today-articles', '/articles/'], ['today-article', `/articles/${owned.find(document => document.status === 'published').id}/`]] : [['home', '/?examples=1'], ['articles', '/articles/?examples=1'], ['article', '/articles/build-a-learning-system/']];
      for (const [label, path] of paths) {
        await page.goto(path, { waitUntil: 'networkidle' });
        if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('Capture requires an authenticated local fixture.');
        if (label === 'today') await page.locator('#today-lists .today-document-link').first().waitFor();
        await page.screenshot({ path: join(output, `${label}-${name}-${theme}.png`), fullPage: !label.endsWith('article') });
        captures++;
      }
      await page.close();
    }
    await context.close();
  }
  console.log(JSON.stringify({ screenshots: captures, output }));
} catch {
  throw new Error('Example-only capture failed; request details were not retained.');
} finally {
  try { if (seedContext) await cleanupToday(seedContext.request, base.origin, owned); }
  catch { throw new Error('Temporary QA capture cleanup failed; no request details retained.'); }
  finally { await browser.close(); }
}
