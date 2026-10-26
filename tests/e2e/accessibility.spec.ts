import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './fixtures';

for (const theme of ['dark', 'light']) {
  test(`example pages and writing workspace meet WCAG AA in ${theme} theme`, async ({ page, context }) => {
    await page.addInitScript(value => localStorage.setItem('asher-theme', value), theme);
    const violations: unknown[] = [];
    for (const path of ['/?examples=1', '/articles/?examples=1', '/articles/build-a-learning-system/', '/manage/', '/login/']) {
      if (path === '/login/') await context.clearCookies();
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      violations.push(...result.violations.map(item => ({ path, id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) })));
    }
    expect(violations, 'WCAG AA violations across the core pages').toEqual([]);
  });
}

test('keyboard search restores focus and leaves the document scrollable', async ({ page }) => {
  await page.goto('/?examples=1');
  const trigger = page.getByRole('button', { name: '搜索文章', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '全文搜索' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
});
