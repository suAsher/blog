/** Capture generated example content only. Credentials never enter screenshots or reports. */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readLocalCredentials } from './local-private-server.mjs';

const mode = process.env.BLOG_CAPTURE_MODE || 'examples';
if (!['examples', 'today', 'knowledge'].includes(mode)) throw new Error('Capture mode must be examples, today or knowledge.');
if (mode !== 'examples' && process.env.BLOG_TEST_LOCAL_AUTH !== '1') throw new Error('Generated private captures require temporary local QA authentication.');

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

async function seedKnowledge(request, origin, record) {
  const titles = ['让知识形成可回看的连接', '把一个好问题留下来', '读完以后，写下自己的判断', '给结论补一条证据', '从片段到主题', '常青笔记的下一次修订', '测试一个反例', '留住失败后的下一步', '让目录变成路标', '两段想法之间的桥', '图谱里的一个新节点', '回顾今天的理解'].map(title => `QA · ${title}`);
  let documents = [];
  for (let index = 0; index < titles.length; index++) {
    const next = index + 1 === titles.length ? 1 : index + 1;
    const targets = index === 0 ? [titles[1], titles[2]] : [titles[0], titles[next]];
    const links = targets.map(title => `[[${title}]]`).join('，以及 ');
    const missing = index === 0 ? '\n\n[[QA · 下一次想继续研究的问题]]' : '';
    const response = await request.post('/api/documents', { headers: { Origin: origin }, data: {
      title: titles[index], description: '仅用于本次本地知识连接验收的生成内容。', date: new Date().toISOString().slice(0, 10),
      tags: [['QA知识连接', 'QA阅读笔记', 'QA实践记录'][index % 3]], category: '临时验收', cover: '',
      kind: index % 3 === 1 ? 'note' : 'article', maturity: index % 2 ? 'growing' : 'evergreen', related: [], series: 'QA知识花园',
      source: `## 从一个问题开始\n\n一条知识不必孤立存在。保留判断的来路，也为下一次回顾留下一条线索。\n\n## 让想法连接起来\n\n继续阅读 ${links}。${missing}\n\n> 本文与所有连接均为本地验收生成的 QA 内容。`,
    } });
    if (!response.ok()) throw new Error('QA knowledge dataset creation failed.');
    let { data } = await response.json();
    record(data);
    const published = await request.post(`/api/documents/${data.id}/publish`, { headers: { Origin: origin }, data: { version: data.version } });
    if (!published.ok()) throw new Error('QA knowledge dataset publication failed.');
    ({ data } = await published.json());
    record(data);
    documents = [...documents, data];
  }
  const graph = await request.get('/api/graph?limit=300&view=published');
  if (!graph.ok()) throw new Error('QA knowledge graph validation failed.');
  const { data } = await graph.json();
  if (data.nodes.length !== 12 || data.edges.length !== 24) throw new Error('QA knowledge graph did not contain exactly its generated connections.');
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
  if (mode !== 'examples') {
    seedContext = await browser.newContext({ baseURL: base.origin, ignoreHTTPSErrors: true });
    const credentials = await readLocalCredentials(base.origin);
    const response = await seedContext.request.post('/auth/login', { headers: { Origin: base.origin }, data: { username: credentials.username, password: credentials.password } });
    if (!response.ok()) throw new Error('Local QA capture login failed.');
    const seed = mode === 'knowledge' ? seedKnowledge : seedToday;
    owned = await seed(seedContext.request, base.origin, document => { owned = [...owned.filter(item => item.id !== document.id), document]; });
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
      const paths = mode === 'knowledge' ? [['graph', '/graph/'], ['backlinks', `/articles/${owned[0].id}/`]] : mode === 'today' ? [['today', '/'], ['today-articles', '/articles/'], ['today-article', `/articles/${owned.find(document => document.status === 'published').id}/`]] : [['home', '/?examples=1'], ['articles', '/articles/?examples=1'], ['article', '/articles/build-a-learning-system/']];
      for (const [label, path] of paths) {
        await page.goto(path, { waitUntil: 'networkidle' });
        if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('Capture requires an authenticated local fixture.');
        if (label === 'graph') await page.locator('#graph-stage[data-layout-ready="true"]').waitFor();
        if (label === 'backlinks') await page.getByRole('region', { name: '反向链接' }).getByRole('link').first().waitFor();
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
