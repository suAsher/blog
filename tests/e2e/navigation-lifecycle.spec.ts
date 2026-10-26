import { test, expect } from './fixtures';

test('repeated page navigation keeps one working search dialog and theme control', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto('/?examples=1');
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '文章', exact: true }).click();
    await expect(page).toHaveURL(/\/articles\//);
    if (process.env.BLOG_TEST_LOCAL_AUTH === '1' || process.env.BLOG_TEST_SSH_TARGET) {
      await page.getByRole('link', { name: '查看示例文章', exact: true }).click();
      await expect(page).toHaveURL(/examples=1/);
    }
    await page.getByRole('button', { name: '搜索文章', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('searchbox', { name: '全文搜索' }).fill('createSingleFlight');
    await expect(page.getByRole('dialog').getByRole('link', { name: /把碎片知识，连成自己的系统/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const theme = await page.locator('html').getAttribute('data-theme');
    await page.getByRole('button', { name: /切换到.*主题/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'dark' ? 'light' : 'dark');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '关于', exact: true }).click();
    await expect(page).toHaveURL(/\/about\//);
  }
  expect(errors).toEqual([]);
});

test('reduced motion remains active through navigation and browser history', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?examples=1');
  await page.getByRole('link', { name: '开始探索' }).click();
  await expect(page).toHaveURL(/\/articles\//);
  await page.goBack();
  await expect(page.locator('h1')).toContainText('让知识生长');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
