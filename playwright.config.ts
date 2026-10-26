import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL ||
  (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'chrome' : undefined);
// Full private-service coverage is the default. Static-only runs opt out explicitly.
const localAuth = process.env.BLOG_TEST_LOCAL_AUTH === '1' ||
  (!process.env.BLOG_TEST_BASE_URL && process.env.BLOG_TEST_STATIC_ONLY !== '1');
if (localAuth) process.env.BLOG_TEST_LOCAL_AUTH = '1';
if (localAuth && (process.env.BLOG_TEST_BASE_URL || process.env.BLOG_TEST_SSH_TARGET)) {
  throw new Error('Local QA mode cannot use deployment origins or SSH targets.');
}
const localPort = Number(process.env.BLOG_TEST_LOCAL_PORT || 4443);
if (localAuth) process.env.BLOG_TEST_LOCAL_FIXTURE ||= `/tmp/asher-blog-private-${process.getuid?.() ?? 'user'}-${localPort}.json`;
const deployed = process.env.BLOG_TEST_BASE_URL !== undefined;

function resolveBaseURL(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('BLOG_TEST_BASE_URL must be an HTTP(S) origin without credentials or a path.');
  }
}

const baseURL = resolveBaseURL(process.env.BLOG_TEST_BASE_URL ?? (localAuth ? `https://127.0.0.1:${localPort}` : 'http://127.0.0.1:4390'));

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: deployed || localAuth ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    ignoreHTTPSErrors: localAuth,
    trace: deployed || localAuth ? 'off' : 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
    channel,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'tablet', use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' } },
  ],
  webServer: deployed ? undefined : localAuth ? {
    command: 'exec node scripts/local-private-server.mjs',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    url: baseURL + '/login/',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 180000,
  } : {
    command: 'npm run preview -- --port 4390 --ignore-lock',
    url: 'http://127.0.0.1:4390',
    reuseExistingServer: false,
  },
});
