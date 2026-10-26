/** Capture generated example content only. Credentials never enter screenshots or reports. */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readLocalCredentials } from './local-private-server.mjs';

const mode = process.env.BLOG_CAPTURE_MODE || 'examples';
if (!['examples', 'today', 'knowledge', 'private'].includes(mode)) throw new Error('Capture mode must be examples, today, knowledge or private.');
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
      title, description: '演示/验收示例，不代表真实经历。只为本次本地界面验收生成。', date, tags: ['QA示例'], category: '临时验收',
      cover: '', source: `> **演示/验收示例，不代表真实经历。**\n\n## 从一个问题开始\n\n${'记录一个观察，保留继续探索的线索。'.repeat(24)}`, kind, maturity, series: 'QA日常观察', related: [],
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
      title: titles[index], description: '演示/验收示例，不代表真实经历。仅用于本次本地知识连接验收。', date: new Date().toISOString().slice(0, 10),
      tags: [['QA知识连接', 'QA阅读笔记', 'QA实践记录'][index % 3]], category: '临时验收', cover: '',
      kind: index % 3 === 1 ? 'note' : 'article', maturity: index % 2 ? 'growing' : 'evergreen', related: [], series: 'QA知识花园',
      source: `> **演示/验收示例，不代表真实经历。**\n\n## 从一个问题开始\n\n一条知识不必孤立存在。保留判断的来路，也为下一次回顾留下一条线索。\n\n## 让想法连接起来\n\n继续阅读 ${links}。${missing}\n\n> 本文与所有连接均为本地验收生成的 QA 内容。`,
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

async function seedPrivate(request, origin, record) {
  const response = await request.post('/api/documents', { headers: { Origin: origin }, data: {
    title: '验收示例 · 加密离线阅读',
    description: '演示/验收示例，不代表真实经历。仅用于本地加密离线功能验收。',
    date: new Date().toISOString().slice(0, 10), tags: ['QA离线验收'], category: '临时验收', cover: '',
    source: '> **演示/验收示例，不代表真实经历。**\n\n## 离线阅读验收\n\n这份临时内容只用于确认正文经加密后保存在当前设备，并能使用独立离线口令解锁。',
  } });
  if (!response.ok()) throw new Error('QA private dataset creation failed.');
  let { data } = await response.json();
  record(data);
  const published = await request.post(`/api/documents/${data.id}/publish`, { headers: { Origin: origin }, data: { version: data.version } });
  if (!published.ok()) throw new Error('QA private dataset publication failed.');
  ({ data } = await published.json());
  record(data);
  return [data];
}

async function cleanupToday(request, origin, documents) {
  let failed = false;
  for (let document of documents) {
    try {
      if (document.status !== 'trash') {
        const response = await request.post(`/api/documents/${document.id}/trash`, { headers: { Origin: origin }, data: { version: document.version } });
        if (!response.ok()) throw new Error('trash failed');
        ({ data: document } = await response.json());
      }
      const response = await request.delete(`/api/documents/${document.id}`, { headers: { Origin: origin }, data: { version: document.version } });
      if (!response.ok()) throw new Error('delete failed');
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('QA generated-document cleanup failed.');
}

const base = new URL(process.env.BLOG_CAPTURE_BASE_URL || 'http://127.0.0.1:4321');
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Capture base must be an HTTP(S) origin.');
const themes = (process.env.BLOG_CAPTURE_THEMES || 'dark,light').split(',');
const allowed = { desktop: { width: 1440, height: 1000 }, tablet: { width: 768, height: 1024 }, mobile: { width: 390, height: 844 } };
const viewports = (process.env.BLOG_CAPTURE_VIEWPORTS || 'desktop,tablet,mobile').split(',');
if (themes.some(theme => !['dark', 'light'].includes(theme)) || viewports.some(name => !allowed[name])) throw new Error('Invalid capture theme or viewport.');
const motion = process.env.BLOG_CAPTURE_MOTION === 'normal' ? 'no-preference' : 'reduce';
const fullPage = process.env.BLOG_CAPTURE_FULL_PAGE !== '0';
const output = resolve(process.env.BLOG_CAPTURE_OUTPUT || 'docs/qa/previews');
await mkdir(output, { recursive: true });
const credentials = process.env.BLOG_TEST_LOCAL_AUTH === '1' ? await readLocalCredentials(base.origin) : undefined;
const browser = await chromium.launch({
  channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  args: credentials ? [`--ignore-certificate-errors-spki-list=${credentials.certificateSPKI}`] : [],
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
});
let captures = 0;
let seedContext;
let owned = [];
let cleanupPromise;
const cleanup = () => cleanupPromise ??= (async () => {
  let failed = false;
  try { if (seedContext) await cleanupToday(seedContext.request, base.origin, owned); }
  catch { failed = true; }
  await browser.close();
  if (failed) throw new Error('Temporary QA capture cleanup failed; no request details retained.');
})();
const onSignal = signal => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, onSignal);
try {
  if (mode !== 'examples') {
    seedContext = await browser.newContext({ baseURL: base.origin, ignoreHTTPSErrors: true });
    const response = await seedContext.request.post('/auth/login', { headers: { Origin: base.origin }, data: { username: credentials.username, password: credentials.password } });
    if (!response.ok()) throw new Error('Local QA capture login failed.');
    const seed = mode === 'knowledge' ? seedKnowledge : mode === 'private' ? seedPrivate : seedToday;
    owned = await seed(seedContext.request, base.origin, document => { owned = [...owned.filter(item => item.id !== document.id), document]; });
  }
  for (const name of viewports) {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: allowed[name], deviceScaleFactor: 1, baseURL: base.origin, ignoreHTTPSErrors: process.env.BLOG_TEST_LOCAL_AUTH === '1', reducedMotion: motion });
      await context.addInitScript(value => localStorage.setItem('asher-theme', value), theme);
      if (credentials) {
        const response = await context.request.post('/auth/login', { headers: { Origin: base.origin }, data: { username: credentials.username, password: credentials.password } });
        if (response.status() !== 200) throw new Error('Local capture login failed.');
      }
      const page = await context.newPage();
      if (mode === 'private') {
        const document = owned[0];
        const passphrase = 'EXAMPLE VAULT 2026';
        await page.goto(`/articles/${document.id}/`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: '保存离线', exact: true }).click();
        const dialog = page.locator('#offline-save-dialog');
        await dialog.getByLabel('离线口令', { exact: true }).fill(passphrase);
        await dialog.getByLabel('再次输入离线口令', { exact: true }).fill(passphrase);
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: '加密保存', exact: true }).click();
        await page.getByRole('button', { name: '已保存离线', exact: true }).waitFor();
        await page.goto('/offline/', { waitUntil: 'networkidle' });
        await page.getByLabel('此设备的离线口令', { exact: true }).fill(passphrase);
        await page.getByRole('button', { name: '解锁离线资料', exact: true }).click();
        await page.getByRole('link', { name: new RegExp(document.title) }).waitFor();
        await page.screenshot({ path: join(output, `offline-${name}-${theme}.png`), fullPage: true });
        captures++;
        if (name === 'desktop') {
          await page.goto('about:blank');
          await context.clearCookies();
          await page.goto('/login/', { waitUntil: 'networkidle' });
          await page.screenshot({ path: join(output, `login-${name}-${theme}.png`), fullPage: true });
          captures++;
        }
        await page.close();
        await context.close();
        continue;
      }
      // Today mode uses only documents generated above in the temporary local QA store.
      const paths = mode === 'knowledge' ? [['graph', '/graph/'], ['backlinks', `/articles/${owned[0].id}/`]] : mode === 'today' ? [['today', '/'], ['today-articles', '/articles/'], ['today-article', `/articles/${owned.find(document => document.status === 'published').id}/`]] : [['home', '/?examples=1'], ['articles', '/articles/?examples=1'], ['article', '/articles/build-a-learning-system/']];
      for (const [label, path] of paths) {
        await page.goto(path, { waitUntil: 'networkidle' });
        if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('Capture requires an authenticated local fixture.');
        if (label === 'graph') await page.locator('#graph-stage[data-layout-ready="true"]').waitFor();
        if (label === 'backlinks') await page.getByRole('region', { name: '反向链接' }).getByRole('link').first().waitFor();
        if (label === 'today') await page.locator('#today-lists .today-document-link').first().waitFor();
        if (label === 'today' && motion === 'no-preference') {
          await page.locator('[data-hero-scene][data-scene-state="active"]').waitFor();
          await page.waitForTimeout(2_000);
          const gradient = await page.locator('.hero-copy h1 .gradient-text').evaluate(element => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return { opacity: Number(style.opacity), width: rect.width, height: rect.height, backgroundImage: style.backgroundImage };
          });
          if (gradient.opacity < 0.99 || gradient.width <= 0 || gradient.height <= 0 || gradient.backgroundImage === 'none') throw new Error('Animated heading did not settle before capture.');
        }
        await page.screenshot({ path: join(output, `${label}-${name}-${theme}.png`), fullPage: fullPage && !label.endsWith('article') });
        captures++;
      }
      await page.close();
      await context.close();
    }
  }
  console.log(JSON.stringify({ screenshots: captures, output }));
} catch {
  throw new Error('Example-only capture failed; request details were not retained.');
} finally {
  for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, onSignal);
  await cleanup();
}
