import { test, expect } from './fixtures';

test('a failed device purge remains visible after the session has ended', async ({ page }) => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET && process.env.BLOG_TEST_LOCAL_AUTH !== '1', 'Requires the private session service.');
  await page.goto('/');
  await page.evaluate(() => {
    document.addEventListener('auth:clear', event => {
      const cleanup = (event as CustomEvent).detail;
      cleanup.waitUntil(Promise.reject(new Error('QA device storage unavailable')));
    }, { once: true });
  });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/\?reason=logout&cleanup=incomplete/);
  await expect(page.locator('#cleanup-warning')).toBeVisible();
  await expect(page.locator('#cleanup-warning')).toContainText('本机存储清理未完成');
  await expect(page.locator('#login-form')).toBeVisible();
});

test('the installed quick-note shortcut opens capture without publishing content', async ({ page }) => {
  await page.goto('/?capture=1');
  const capture = page.getByRole('dialog', { name: /^新建随手记/ });
  await expect(capture).toBeVisible();
  await expect(capture.getByLabel('随手记内容', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(capture).not.toBeVisible();
});

test('logout locks the device even when its server response is lost', async ({ page }) => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET && process.env.BLOG_TEST_LOCAL_AUTH !== '1', 'Requires the private session service.');
  await page.goto('/');
  await page.evaluate(() => {
    document.addEventListener('auth:clear', () => {
      document.documentElement.dataset.qaDeviceLocked = 'true';
    }, { once: true });
  });
  await page.route('**/auth/logout', route => route.abort('connectionfailed'));
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-qa-device-locked', 'true');
  await expect(page.locator('#toast')).toContainText('服务器尚未确认退出');
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
});
