import { test, expect } from './fixtures';

test('only the selected article cover receives the shared transition name', async ({ page }) => {
  await page.goto('/articles/?examples=1');
  const cards = page.locator('.article-card');
  await expect(cards).toHaveCount(6);
  for (const index of [0, 1]) {
    await page.evaluate(() => document.addEventListener('click', event => event.preventDefault(), { once: true }));
    await cards.nth(index).locator('h3 a').click();
    await expect(page.locator('img[style*="view-transition-name: article-cover"]')).toHaveCount(1);
    await expect(cards.nth(index).locator('.card-cover img')).toHaveCSS('view-transition-name', 'article-cover');
  }
});

test('published text becomes readable while an article image is still loading', async ({ page }) => {
  const id = '1234567890abcdef1234567890abcdef';
  let releaseImage!: () => void;
  let requestedImage!: () => void;
  const imageStarted = new Promise<void>(resolve => { requestedImage = resolve; });
  const imageReleased = new Promise<void>(resolve => { releaseImage = resolve; });
  await page.route('**/delayed-reading-image.png', async route => {
    requestedImage();
    await imageReleased;
    await route.abort();
  });
  await page.route(`**/api/documents/${id}?view=published`, route => route.fulfill({
    json: { ok: true, data: {
      id, title: '演示：文字先于图片出现', description: '加载回归测试',
      date: '2026-10-26', tags: [], category: '', cover: '', readingMinutes: 1,
      source: '', headings: [], html: '<p>这段文字应该立即可读。</p><img src="/delayed-reading-image.png" alt="加载中的演示图片">',
    } },
  }));
  try {
    await page.goto(`/reader/?id=${id}`, { waitUntil: 'domcontentloaded' });
    await imageStarted;
    await expect(page.locator('#live-reader')).toBeVisible({ timeout: 700 });
    await expect(page.locator('#article-body')).toContainText('这段文字应该立即可读。');
  } finally {
    releaseImage();
  }
});
