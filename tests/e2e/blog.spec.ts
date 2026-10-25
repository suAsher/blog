import { test, expect, type Page } from './fixtures';
import { readFile } from 'node:fs/promises';

const featuredTitle = '把碎片知识，连成自己的系统';
const featuredPath = '/articles/build-a-learning-system/';
const bookmarkLabel = `收藏：${featuredTitle}`;
const savedLabel = `取消收藏：${featuredTitle}`;

async function openFeatured(page: Page) {
  await page.goto(featuredPath);
  await expect(page.getByRole('heading', { level: 1, name: featuredTitle })).toBeVisible();
}

test('home introduces the demo garden and navigation opens six articles', async ({ page }) => {
  await page.goto('/?examples=1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('让知识生长');
  await expect(page.getByText('当前为演示内容', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: '开始探索' }).click();
  await expect(page).toHaveURL(/\/articles\/$/);
  await page.getByRole('link', { name: '查看示例文章', exact: true }).click();
  await expect(page).toHaveURL(/examples=1/);
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(6);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '关于', exact: true }).click();
  await expect(page.getByText('文中没有作者真实工作经历，也没有导入任何本机文档。', { exact: false })).toBeVisible();
});

test('full-text search finds code in the body and handles zero results', async ({ page }) => {
  await page.goto('/articles/?examples=1');
  const query = page.getByRole('searchbox', { name: '搜索文章全文' });
  await query.fill('createSingleFlight');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
  await expect(page.locator('#article-results')).toContainText(featuredTitle);
  await expect(page.getByRole('status').filter({ hasText: '共 1 篇文章' })).toBeVisible();
  await query.fill('a-phrase-that-does-not-exist-713');
  await expect(page.getByRole('heading', { name: '还没有找到这片叶子' })).toBeVisible();
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(0);
  await page.getByRole('button', { name: '清除搜索与筛选' }).click();
  await expect(query).toHaveValue('');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(6);
});

test('tags and content-generated categories combine with search', async ({ page }) => {
  await page.goto('/articles/?examples=1');
  await page.getByRole('button', { name: /^知识管理 / }).click();
  await expect(page).toHaveURL(/tag=/);
  await expect(page.getByRole('button', { name: /^知识管理 / })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('searchbox', { name: '搜索文章全文' }).fill('createSingleFlight');
  await page.getByRole('combobox', { name: '分类', exact: true }).selectOption('思考与方法');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('searchbox', { name: '搜索文章全文' })).toHaveValue('createSingleFlight');
  await expect(page.getByRole('combobox', { name: '分类', exact: true })).toHaveValue('思考与方法');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
});

test('keyboard search opens, searches, closes and opens a result', async ({ page }) => {
  await page.goto('/?examples=1');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  const input = dialog.getByRole('searchbox', { name: '全文搜索' });
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('createSingleFlight');
  await expect(dialog.getByRole('link', { name: new RegExp(featuredTitle) })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '搜索文章', exact: true }).click();
  await dialog.getByRole('link', { name: new RegExp(featuredTitle) }).click();
  await expect(page).toHaveURL(new RegExp(`${featuredPath}$`));
});

test('bookmarks persist after reload and can be removed from the shelf', async ({ page }) => {
  await openFeatured(page);
  await page.getByRole('button', { name: bookmarkLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: savedLabel, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', { name: savedLabel, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的书架' }).click();
  await expect(page.locator('#library-results').getByRole('link', { name: featuredTitle, exact: true })).toBeVisible();
  await expect(page.getByText('不同设备不会同步', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: savedLabel, exact: true }).click();
  await expect(page.getByRole('heading', { name: '书架空着，好奇心没有' })).toBeVisible();
  await page.reload();
  await expect(page.locator('#library-results .article-card')).toHaveCount(0);
});

test('read status is reversible and reflected in the read shelf', async ({ page }) => {
  await openFeatured(page);
  await page.getByRole('button', { name: '标为已读', exact: true }).click();
  await expect(page.getByRole('button', { name: '已读 · 撤销', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/library/');
  await page.getByRole('button', { name: '已经读过', exact: true }).click();
  await page.locator('#library-results').getByRole('link', { name: featuredTitle, exact: true }).click();
  await page.getByRole('button', { name: '已读 · 撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '标为已读', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.goto('/library/');
  await page.getByRole('button', { name: '已经读过', exact: true }).click();
  await expect(page.getByRole('heading', { name: '每一次读完，都算一次成长' })).toBeVisible();
});

test('scroll progress survives navigation and resumes at the saved position', async ({ page }) => {
  await openFeatured(page);
  await page.getByRole('heading', { name: '03 · 让笔记包含判断的依据', exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(async () => Number((await page.locator('#reading-percent').textContent())?.replace('%', ''))).toBeGreaterThan(10);
  const progress = Number((await page.locator('#reading-percent').textContent())?.replace('%', ''));
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')['build-a-learning-system']?.progress || 0)).toBeGreaterThan(10);
  await page.goto('/library/');
  await page.getByRole('button', { name: '继续阅读', exact: true }).click();
  await page.locator('#library-results').getByRole('link', { name: featuredTitle, exact: true }).click();
  await expect(page).toHaveURL(/resume=1/);
  await expect.poll(async () => Number((await page.locator('#reading-percent').textContent())?.replace('%', ''))).toBeGreaterThan(progress - 3);
  await expect.poll(async () => Number((await page.locator('#reading-percent').textContent())?.replace('%', ''))).toBeLessThan(progress + 3);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
});

test('focus mode supports keyboard exit and ignores typing in search', async ({ page }) => {
  await openFeatured(page);
  await page.keyboard.press('f');
  await expect(page.getByRole('button', { name: '退出专注 Esc' })).toBeVisible();
  await expect(page.locator('.site-header')).not.toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: '全文搜索' }).fill('createSingleFlight');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.site-header')).toBeVisible();
  await page.getByRole('button', { name: '搜索文章', exact: true }).click();
  await page.getByRole('searchbox', { name: '全文搜索' }).pressSequentially('f');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('homepage continuation refreshes when another tab marks the article read', async ({ page, context }) => {
  await openFeatured(page);
  await page.getByRole('heading', { name: '03 · 让笔记包含判断的依据', exact: true }).scrollIntoViewIfNeeded();
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')['build-a-learning-system']?.progress || 0)).toBeGreaterThan(10);
  const home = await context.newPage();
  await home.goto('/');
  await expect(home.locator('#continue-reading')).toContainText(featuredTitle);
  await page.getByRole('button', { name: '标为已读', exact: true }).click();
  await expect(page.getByRole('button', { name: '已读 · 撤销', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(home.locator('#continue-reading')).toContainText('给好奇心，留一个位置。');
  await expect(home.locator('#continue-reading')).not.toContainText(featuredTitle);
  await home.close();
});

test('code copy, readable table, image and table of contents work', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFeatured(page);
  await page.getByRole('button', { name: '复制代码', exact: true }).first().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('function createSingleFlight');
  await expect(page.locator('#article-body pre code span[style]').first()).toBeAttached();
  await expect(page.getByRole('region', { name: '文章表格，可左右滚动' })).toBeAttached();
  const articleImage = page.getByRole('img', { name: /抽象轨道/ });
  await expect(articleImage).toBeAttached();
  await expect.poll(() => articleImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const mobileToc = page.locator('.mobile-toc');
  if (await mobileToc.isVisible()) {
    await mobileToc.getByText('文章目录', { exact: false }).click();
    await page.getByRole('navigation', { name: '移动端文章目录' }).getByRole('link', { name: '05 · 给知识一个回访节奏', exact: true }).click();
  } else {
    const tocLink = page.getByRole('navigation', { name: '文章目录', exact: true }).getByRole('link', { name: '05 · 给知识一个回访节奏', exact: true });
    await tocLink.click();
    await expect(tocLink).toHaveClass(/active/);
  }
  await expect(page).toHaveURL(/#05/);
});

test('theme choice persists across pages and reloads', async ({ page }) => {
  await page.goto('/?examples=1');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.goto(featuredPath);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('article return navigation and browser back retain search filters', async ({ page }) => {
  await page.goto('/articles/?examples=1');
  await page.getByRole('searchbox', { name: '搜索文章全文' }).fill('createSingleFlight');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
  await page.locator('#article-results').getByRole('link', { name: featuredTitle, exact: true }).click();
  await page.getByRole('link', { name: '返回文章', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: '搜索文章全文' })).toHaveValue('createSingleFlight');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
  await page.locator('#article-results').getByRole('link', { name: featuredTitle, exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('searchbox', { name: '搜索文章全文' })).toHaveValue('createSingleFlight');
});

test('return keeps filters when the reader module has not downloaded yet', async ({ page }) => {
  await page.goto('/articles/?examples=1');
  await page.getByRole('searchbox', { name: '搜索文章全文' }).fill('createSingleFlight');
  await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);

  let releaseReader!: () => void;
  let readerBlocked = false;
  const readerGate = new Promise<void>(resolve => { releaseReader = resolve; });
  await page.route('**/_astro/*.js', async route => {
    if (new URL(route.request().url()).pathname.includes('_...id_.astro_')) {
      readerBlocked = true;
      await readerGate;
    }
    await route.continue().catch(() => { /* The quick return may cancel this request. */ });
  });
  try {
    await page.locator('#article-results').getByRole('link', { name: featuredTitle, exact: true }).click({ noWaitAfter: true });
    const back = page.getByRole('link', { name: '返回文章', exact: true });
    await expect(back).toBeVisible();
    await expect.poll(() => readerBlocked).toBe(true);
    await back.click({ noWaitAfter: true });
    await expect(page.getByRole('searchbox', { name: '搜索文章全文' })).toHaveValue('createSingleFlight');
    await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
  } finally {
    releaseReader();
  }
});

test('opening an article keeps filters before the global app module is ready', async ({ page }) => {
  let releaseApp!: () => void;
  let appBlocked = false;
  const appGate = new Promise<void>(resolve => { releaseApp = resolve; });
  await page.route('**/_astro/*.js', async route => {
    if (new URL(route.request().url()).pathname.includes('Layout.astro_')) {
      appBlocked = true;
      await appGate;
    }
    await route.continue().catch(() => { /* Navigation may cancel the delayed module. */ });
  });
  try {
    await page.goto('/articles/?q=createSingleFlight&examples=1', { waitUntil: 'commit' });
    await expect(page.locator('#article-results .article-card:visible')).toHaveCount(1);
    await expect.poll(() => appBlocked).toBe(true);
    await page.locator('#article-results').getByRole('link', { name: featuredTitle, exact: true }).click({ noWaitAfter: true });
    releaseApp();
    await expect(page.locator('#article-body .code-copy').first()).toBeVisible();
    await page.getByRole('link', { name: '返回文章', exact: true }).click();
    await expect(page.getByRole('searchbox', { name: '搜索文章全文' })).toHaveValue('createSingleFlight');
  } finally {
    releaseApp();
  }
});

test('responsive pages fit viewport and reduced motion stops decorative animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const path of ['/', '/articles/', featuredPath, '/library/', '/about/']) {
    await page.goto(path);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await page.goto('/?examples=1');
  await expect(page.locator('.point-one')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
});

test('JSON backup restores records and rejects malformed input without erasing them', async ({ page }) => {
  await openFeatured(page);
  await page.getByRole('button', { name: bookmarkLabel, exact: true }).click();
  await page.goto('/library/');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出记录', exact: true }).click();
  const download = await downloadPromise;
  const backup = await readFile((await download.path())!, 'utf8');
  expect(JSON.parse(backup).entries['build-a-learning-system'].bookmarked).toBe(true);
  await page.getByRole('button', { name: savedLabel, exact: true }).click();
  await expect(page.locator('#library-results .article-card')).toHaveCount(0);
  await page.locator('#import-reading').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.locator('#library-results').getByRole('link', { name: featuredTitle, exact: true })).toBeVisible();
  await page.locator('#import-reading').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{not-json}') });
  await expect(page.getByRole('status').filter({ hasText: '无法导入' })).toBeVisible();
  await expect(page.locator('#library-results').getByRole('link', { name: featuredTitle, exact: true })).toBeVisible();
});

test('blocked local storage keeps current-page bookmarking usable with an honest warning', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await openFeatured(page);
  await page.getByRole('button', { name: bookmarkLabel, exact: true }).click();
  await expect(page.getByRole('button', { name: savedLabel, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: '浏览器不允许保存记录' })).toBeVisible();
  await page.getByRole('button', { name: '切换到浅色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('missing pages return a useful 404 with working recovery navigation', async ({ page, baseURL }) => {
  const response = await page.goto('/missing-page-for-test/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: '这颗星，暂时不在轨道上。' })).toBeVisible();
  await page.getByRole('link', { name: '回到知识空间' }).click();
  await expect(page).toHaveURL(new URL('/', baseURL).href);
});

test('core pages require no external requests and have no browser script errors', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const external: string[] = [];
  const origin = new URL('/', baseURL).origin;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url());
  });
  for (const path of ['/', '/articles/', featuredPath, '/library/', '/about/']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('a[href="#"],a[href=""],button:disabled:visible')).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
