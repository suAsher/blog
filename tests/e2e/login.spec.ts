import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { establishSession, submitRealLogin } from './fixtures';

const article = '/articles/build-a-learning-system/';
const title = '把碎片知识，连成自己的系统';
const cookieName = '__Host-asher_session';

test.describe('deployed cookie login', () => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET && process.env.BLOG_TEST_LOCAL_AUTH !== '1', 'Requires an explicitly authorized deployment SSH target and HTTPS endpoint.');

  test('anonymous article, index and image redirect to the custom login without a native challenge', async ({ page, request }) => {
    for (const path of [article, '/search-index.json', '/images/orbit.svg']) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers()['www-authenticate']).toBeUndefined();
      expect(response.headers().location).toMatch(/^\/login\/\?next=/);
    }
    await page.goto(article);
    await expect(page).toHaveURL(/\/login\/\?next=/);
    await expect(page.getByRole('heading', { name: '欢迎回来。', exact: true })).toBeVisible();
  });

  test('the real login form returns to the requested article with a secure browser-session cookie', async ({ page, context, baseURL }) => {
    await page.goto('/login/?next=' + encodeURIComponent(article));
    await submitRealLogin(page, baseURL);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page).toHaveURL(baseURL + article);
    const cookie = (await context.cookies()).find(item => item.name === cookieName);
    expect(Boolean(cookie?.secure)).toBe(true);
    expect(Boolean(cookie?.httpOnly)).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.expires).toBe(-1);
  });

  test('a wrong password shows an inline error and the same form can retry successfully', async ({ page, baseURL }) => {
    await page.goto('/login/?next=/library/');
    await page.getByLabel('账号', { exact: true }).fill('asher');
    await page.getByLabel('密码', { exact: true }).fill('deliberately-incorrect-test-password');
    await page.getByRole('button', { name: '进入知识空间', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('账号或密码不正确');
    await expect(page.getByRole('button', { name: '进入知识空间', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/\/login\//);
    await submitRealLogin(page, baseURL);
    await expect(page).toHaveURL(baseURL + '/library/');
  });

  test('password visibility, keyboard, theme and seven-day remember option work', async ({ page, context, baseURL }) => {
    await page.goto('/login/');
    const password = page.getByLabel('密码', { exact: true });
    await password.fill('non-secret-display-test');
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '切换到浅色主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await page.getByLabel('账号', { exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(password).toBeFocused();
    await submitRealLogin(page, baseURL, true);
    await expect(page).toHaveURL(baseURL + '/');
    const expiry = (await context.cookies()).find(item => item.name === cookieName)?.expires || 0;
    expect(expiry - Date.now() / 1000).toBeGreaterThan(6 * 24 * 3600);
  });

  test('logout clears the browser cookie and revokes the old server token', async ({ page, context, baseURL }) => {
    await establishSession(context, baseURL);
    const localEntryKey = `qa-local-logout-${randomUUID()}`;
    const token = (await context.cookies()).find(cookie => cookie.name === cookieName)?.value;
    if (!token) throw new Error('Deployment test session was not created.');
    await page.goto('/');
    const initialReadingSync = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/reading-state' && response.request().method() === 'GET');
    const articleResponse = await page.goto(article);
    await initialReadingSync;
    await expect(page.locator('#reading-sync-status')).toHaveAttribute('data-sync-phase', 'synced');
    const articleHeaders = await articleResponse?.allHeaders();
    expect(articleHeaders?.['cache-control']).toContain('no-store');
    await page.evaluate(key => {
      localStorage.setItem('asher-theme', 'light');
      localStorage.setItem('asher-reading-v1', JSON.stringify({
        [key]: { bookmarked: true, read: false, progress: 23, updatedAt: Date.now() },
      }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'asher-reading-v1' }));
    }, localEntryKey);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')[key]?.bookmarked, localEntryKey)).toBe(true);
    const logoutResponse = page.waitForResponse(response => response.url().endsWith('/auth/logout') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    const logoutHeaders = await (await logoutResponse).allHeaders();
    expect(logoutHeaders['cache-control']).toContain('no-store');
    expect(logoutHeaders['clear-site-data']).toContain('cache');
    await expect(page).toHaveURL(/\/login\/\?reason=logout/);
    await expect(page.getByText('已安全退出，期待下一次探索。')).toBeVisible();
    expect((await context.cookies()).some(cookie => cookie.name === cookieName)).toBe(false);
    let status: number;
    try {
      status = (await context.request.get('/search-index.json', {
        maxRedirects: 0, headers: { Cookie: cookieName + '=' + token },
      })).status();
    } catch { throw new Error('Unable to verify revoked-session access.'); }
    expect(status).toBe(302);
    const session = await context.request.get('/auth/session');
    expect((await session.json()).authenticated).toBe(false);
    await page.goBack();
    await expect(page).toHaveURL(/\/login\//);
    await expect(page.getByRole('heading', { name: '欢迎回来。', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('asher-theme'))).toBe('light');
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')[key]?.bookmarked, localEntryKey)).toBe(true);
  });

  test('untrusted next values cannot redirect outside the space', async ({ page, context, baseURL }) => {
    await page.goto('/login/?next=' + encodeURIComponent('//evil.invalid/private'));
    await submitRealLogin(page, baseURL);
    await expect(page).toHaveURL(baseURL + '/');
    const result = await establishSession(context, baseURL, false, 'https://evil.invalid/');
    expect(result?.redirect).toBe('/');
  });

  test('cross-origin login and logout are rejected while an existing session remains valid', async ({ context, request, baseURL }) => {
    const login = await request.post('/auth/login', {
      headers: { Origin: 'https://evil.invalid' },
      data: { username: 'qa-csrf-probe', password: randomUUID() },
    });
    expect(login.status()).toBe(403);
    await establishSession(context, baseURL);
    const logout = await context.request.post('/auth/logout', { headers: { Origin: 'https://evil.invalid' }, data: {} });
    expect(logout.status()).toBe(403);
    const state = await context.request.get('/auth/session');
    expect((await state.json()).authenticated).toBe(true);
    expect((await request.get('/auth/login')).status()).toBe(405);
  });

  test('a separate browser context cannot inherit another context session', async ({ context, browser, baseURL }) => {
    await establishSession(context, baseURL);
    const isolated = await browser.newContext({ baseURL, ignoreHTTPSErrors: process.env.BLOG_TEST_LOCAL_AUTH === '1' });
    try {
      const response = await isolated.request.get('/search-index.json', { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers()['www-authenticate']).toBeUndefined();
    } finally { await isolated.close(); }
  });

  test('the login page fits the viewport, respects reduced motion and loads only local assets', async ({ page, baseURL }) => {
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(error.name));
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== baseURL) external.push(new URL(request.url()).origin);
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login/');
    await expect(page.locator('#login-title')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('.orbit-one')).toHaveCSS('animation-name', 'none');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});
