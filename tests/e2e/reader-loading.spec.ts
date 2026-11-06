import { test, expect } from './fixtures';
import { ContentHarness, sampleContent } from './content-helpers';

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

test("article text is usable while optional code highlighting is still loading", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let requested = false;
  await page.route("**/reader-highlight*.js", async (route) => {
    requested = true;
    await delayed;
    await route.continue();
  });
  try {
    const doc = await content.action(await content.create(sampleContent(
      "progressive reading",
      "## 先读问题\n\n代码高亮尚未到达时，这段正文也应该可以阅读。\n\n```python\nprint(42)\n```",
    )), "publish");
    await page.goto(`/articles/${doc.id}/`);
    await expect(page.locator("#live-title")).toBeVisible();
    await expect(page.locator("#article-body")).toContainText("这段正文也应该可以阅读");
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator("#article-body code")).toHaveText("print(42)\n");
    release();
    await expect(page.locator("#article-body code.hljs")).toBeVisible();
    await expect(page.locator("#annotations")).toBeVisible();
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
  } finally {
    release();
    await content.cleanup();
  }
});

test("stalled highlighting falls back to plain code without disabling annotations", async ({ page, context, baseURL }) => {
  const content = new ContentHarness(context.request, baseURL!);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/reader-highlight*.js", async (route) => {
    await delayed;
    await route.continue();
  });
  try {
    const doc = await content.action(await content.create(sampleContent(
      "plain code fallback", "## 原文\n\n仍然可以留下批注。\n\n```python\nprint(42)\n```",
    )), "publish");
    await page.goto(`/articles/${doc.id}/`);
    await expect(page.locator("#article-body")).toContainText("仍然可以留下批注");
    await expect(page.locator("#annotations")).toBeVisible();
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
    const finished = page.waitForResponse(response => /\/reader-highlight[^/]+\.js$/.test(new URL(response.url()).pathname));
    release();
    await finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator("#article-body code")).toHaveText("print(42)\n");
    await expect(page.locator("#article-body code.hljs")).toHaveCount(0);
  } finally {
    release();
    await content.cleanup();
  }
});
