/** Controlled localhost audits. Persist aggregate metrics only: no cookies, credentials, or HTML. */
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startPrivateServer, readLocalCredentials } from './local-private-server.mjs';

const output = resolve(process.env.BLOG_PERF_OUTPUT || '/tmp/asher-blog-performance.json');
const samples = Number(process.env.BLOG_PERF_SAMPLES || 3);
if (!Number.isInteger(samples) || samples < 3 || samples > 10) throw new Error('Performance audits require 3–10 samples.');
const count = Number(process.env.BLOG_PERF_DOCUMENTS || 30);
if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('Invalid QA dataset size.');
const service = await startPrivateServer();
let browser;
let chrome;
try {
  const credentials = await readLocalCredentials(service.origin, service.fixture);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ baseURL: service.origin, ignoreHTTPSErrors: true });
  const response = await context.request.post('/auth/login', { headers: { Origin: service.origin }, data: { username: credentials.username, password: credentials.password } });
  if (response.status() !== 200) throw new Error('Local performance login failed.');
  for (let index = 0; index < count; index++) {
    const created = await context.request.post('/api/documents', { headers: { Origin: service.origin }, data: {
      title: `QA 性能样本 ${String(index + 1).padStart(3, '0')}`, description: '自动生成的性能验收数据。', date: '2026-10-25',
      tags: ['QA性能'], category: 'QA示例', cover: '', source: `## 性能测试\n\n${'这是只存在于临时测试环境中的示例正文。'.repeat(80)}`,
    } });
    if (!created.ok()) throw new Error('Performance QA dataset creation failed.');
    const { data } = await created.json();
    const published = await context.request.post(`/api/documents/${data.id}/publish`, { headers: { Origin: service.origin }, data: { version: data.version } });
    if (!published.ok()) throw new Error('Performance QA dataset publication failed.');
  }
  const cookie = (await context.cookies(service.origin)).find(value => value.name === '__Host-asher_session');
  if (!cookie) throw new Error('Local audit session unavailable.');
  const chromePath = process.env.CHROME_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  chrome = await launch({ chromePath, chromeFlags: ['--headless=new', '--ignore-certificate-errors', '--disable-background-networking', '--disable-extensions'] });
  let chromeVersion = browser.version();
  await browser.close(); browser = undefined;
  const paths = (process.env.BLOG_PERF_PATHS || '/,/articles/,/articles/build-a-learning-system/,/manage/').split(',');
  const results = [];
  for (const formFactor of ['mobile', 'desktop']) {
    for (const path of paths) {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Audit paths must be local paths.');
      const runs = [];
      for (let sample = 0; sample < samples; sample++) {
        const report = await lighthouse(service.origin + path, {
          port: chrome.port, logLevel: 'error', output: 'json', onlyCategories: ['performance', 'accessibility', 'best-practices'],
          formFactor, screenEmulation: formFactor === 'desktop' ? { mobile: false, width: 1440, height: 1000, deviceScaleFactor: 1, disabled: false } : { mobile: true, width: 390, height: 844, deviceScaleFactor: 1, disabled: false },
          throttlingMethod: 'simulate',
          extraHeaders: { Cookie: `${cookie.name}=${cookie.value}` },
          disableStorageReset: false,
        }, formFactor === 'desktop' ? { extends: 'lighthouse:default', settings: { formFactor: 'desktop', throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } } } : undefined);
        const lhr = report.lhr;
        chromeVersion = lhr.environment.hostUserAgent.match(/Chrome\/([\d.]+)/)?.[1] || chromeVersion;
        if (lhr.runtimeError || !lhr.finalDisplayedUrl.startsWith(service.origin + path.split('?')[0]) || lhr.finalDisplayedUrl.includes('/login')) throw new Error('Audit did not measure the authenticated target page.');
        runs.push({ performance: lhr.categories.performance.score * 100, accessibility: lhr.categories.accessibility.score * 100, bestPractices: lhr.categories['best-practices'].score * 100, lcpMs: lhr.audits['largest-contentful-paint'].numericValue });
        console.log(`${formFactor} ${path}: sample ${sample + 1}/${samples} complete`);
      }
      const metrics = Object.fromEntries(Object.keys(runs[0]).map(key => {
        const sorted = runs.map(run => run[key]).sort((a, b) => a - b);
        return [key, { median: sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, worst: key === 'lcpMs' ? sorted.at(-1) : sorted[0] }];
      }));
      results.push({ formFactor, path, metrics, runs });
    }
  }
  const summary = { measuredAt: new Date().toISOString(), chromeVersion, lighthouseVersion: (await import('lighthouse/package.json', { with: { type: 'json' } })).default.version, samples, dataset: { documents: count, source: 'Generated QA fixtures only; temporary real Go store' }, transport: 'loopback HTTPS; self-signed certificate; real cookie authentication', cache: 'Lighthouse resets HTTP cache and browser storage before each sample', results };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Aggregate performance report: ${output}`);
} finally {
  await browser?.close();
  chrome?.kill();
  await service.stop();
}
