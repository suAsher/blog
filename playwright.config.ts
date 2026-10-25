import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const channel = process.env.PLAYWRIGHT_CHANNEL ||
  (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? 'chrome' : undefined);
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

const baseURL = resolveBaseURL(process.env.BLOG_TEST_BASE_URL ?? 'http://127.0.0.1:4321');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 3,
  retries: 0,
  reporter: deployed ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: deployed ? 'off' : 'retain-on-failure',
    screenshot: 'off',
    video: 'off',
    channel,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'tablet', use: { ...devices['iPad Mini'], defaultBrowserType: 'chromium' } },
  ],
  webServer: deployed ? undefined : {
    command: 'npm run preview -- --port 4321',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
  },
});
