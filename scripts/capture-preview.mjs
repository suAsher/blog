/** Capture generated example content only. Credentials never enter screenshots or reports. */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readLocalCredentials } from './local-private-server.mjs';

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
try {
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
      // All content routes below are generated examples. Never enumerate private documents.
      for (const [label, path] of [['home', '/?examples=1'], ['articles', '/articles/?examples=1'], ['article', '/articles/build-a-learning-system/']]) {
        await page.goto(path, { waitUntil: 'networkidle' });
        if (new URL(page.url()).pathname.startsWith('/login')) throw new Error('Capture requires an authenticated local fixture.');
        await page.screenshot({ path: join(output, `${label}-${name}-${theme}.png`), fullPage: label !== 'article' });
        captures++;
      }
      await page.close();
    }
    await context.close();
  }
  console.log(JSON.stringify({ screenshots: captures, output }));
} catch {
  throw new Error('Example-only capture failed; request details were not retained.');
} finally { await browser.close(); }
