import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

interface DeploymentCredentials { origin: string; username: string; password: string }
let cached: DeploymentCredentials | undefined;

export function loadDeploymentCredentials(baseURL: string | undefined): DeploymentCredentials | undefined {
  const target = process.env.BLOG_TEST_SSH_TARGET;
  if (target === undefined) return undefined;
  try {
    const origin = new URL(baseURL || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash ||
        !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(target)) throw new Error();
    if (cached) {
      if (cached.origin !== origin.origin) throw new Error();
      return cached;
    }
    // Explicit opt-in; credentials remain in this process, never in report/config files.
    const raw = execFileSync('ssh', [
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', target,
      'cat /srv/asher-knowledge/secrets/access.json',
    ], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (typeof record.url !== 'string' || typeof record.username !== 'string' ||
        typeof record.password !== 'string' || !record.username.trim() ||
        !record.password.trim() || /[:\r\n]/.test(record.username)) throw new Error();
    const address = new URL(record.url);
    if (address.origin !== origin.origin || address.protocol !== 'https:' ||
        address.username || address.password || address.search || address.hash ||
        address.pathname !== '/') throw new Error();
    cached = { origin: origin.origin, username: record.username, password: record.password };
    return cached;
  } catch {
    throw new Error('Unable to load deployment credentials for the configured HTTPS origin.');
  }
}

export async function establishSession(context: BrowserContext, baseURL: string | undefined, remember = false, next = '/') {
  const credentials = loadDeploymentCredentials(baseURL);
  if (!credentials) return;
  try {
    const response = await context.request.post(credentials.origin + '/auth/login', {
      headers: { Origin: credentials.origin },
      data: { username: credentials.username, password: credentials.password, remember, next },
    });
    if (response.status() !== 200) throw new Error();
    const result = await response.json();
    if (result.ok !== true) throw new Error();
    const cookies = await context.cookies(credentials.origin);
    if (!cookies.some(cookie => cookie.name === '__Host-asher_session' && cookie.httpOnly && cookie.secure)) throw new Error();
    return result as { ok: true; redirect: string };
  } catch {
    throw new Error('Unable to establish the deployment test session.');
  }
}

export async function submitRealLogin(page: Page, baseURL: string | undefined, remember = false) {
  const credentials = loadDeploymentCredentials(baseURL);
  if (!credentials) throw new Error('Deployment login requires an explicit SSH target.');
  try {
    await page.locator('#username').evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, credentials.username);
    await page.locator('#password').evaluate((element, value) => {
      (element as HTMLInputElement).value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, credentials.password);
    await page.locator('#remember').setChecked(remember);
    await page.getByRole('button', { name: '进入知识空间', exact: true }).click();
  } catch {
    // Never expose locator evaluation arguments or request bodies in test errors.
    throw new Error('Unable to submit the deployment login form.');
  }
}

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    await establishSession(context, baseURL);
    await use(context);
  },
});
export { expect, type Page };
