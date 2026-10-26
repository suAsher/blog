import { test as authenticatedTest, expect } from './fixtures';
import { ContentHarness, sampleContent, tinyPNG, uniqueName, unwrap } from './content-helpers';
import type { DocumentDetail } from '../../src/lib/documents';

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || '');
    try { await use(content); } finally { await content.cleanup(); }
  },
});
const example = '/articles/build-a-learning-system/';

test.describe('interactive reading and discovery', () => {
  test('reading preferences change real typography, survive reload and reset to bounded defaults', async ({ page }) => {
    await page.goto(example);
    await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '让阅读，更合你的习惯' });
    await settings.getByRole('button', { name: '21 · 宽松', exact: true }).click();
    await settings.getByRole('button', { name: '展开', exact: true }).click();
    await settings.getByRole('button', { name: '舒展', exact: true }).click();
    await expect(page.locator('#article-body')).toHaveCSS('font-size', '21px');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('asher-reading-preferences-v1') || '{}'))).toEqual({ fontSize: 21, width: 860, lineHeight: 2.2 });
    await page.keyboard.press('Escape');
    await expect(settings).not.toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
    await page.reload();
    await expect(page.locator('#article-body')).toHaveCSS('font-size', '21px');
    await page.getByRole('button', { name: '阅读设置', exact: true }).click();
    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await expect(page.locator('#article-body')).toHaveCSS('font-size', '19px');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('asher-reading-preferences-v1') || '{}'))).toEqual({ fontSize: 19, width: 760, lineHeight: 2 });
  });

  test('an article image opens an accessible full-size view and Escape returns to reading', async ({ page }) => {
    await page.goto(example);
    const opener = page.getByRole('button', { name: /^放大图片：/ }).first();
    const original = opener.getByRole('img');
    await expect.poll(() => original.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const source = await original.getAttribute('src');
    await opener.click();
    const viewer = page.getByRole('dialog', { name: '文章图片预览' });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('img')).toHaveAttribute('src', new RegExp(source!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    await page.keyboard.press('Escape');
    await expect(viewer).not.toBeVisible();
    await expect(opener).toBeFocused();
  });

  test('a Mermaid diagram retries a failed local engine load, zooms and keeps its source available', async ({ page }) => {
    test.setTimeout(60000);
    let failedOnce = false;
    await page.route(/(?:mermaid\.core[^/]*\.js|\/mermaid\.js)(?:\?.*)?$/, async route => {
      if (!failedOnce) {
        failedOnce = true;
        await route.fulfill({ status: 503, contentType: 'application/javascript', body: '/* temporary QA failure */' });
      } else await route.continue();
    });
    await page.goto('/lab/');
    const diagram = page.locator('#lab-diagram .diagram-widget');
    await diagram.scrollIntoViewIfNeeded();
    const reload = page.waitForNavigation({ waitUntil: 'load' });
    await diagram.getByRole('button', { name: '刷新页面并重试流程图', exact: true }).click({ timeout: 30000 });
    await reload;
    expect(failedOnce).toBe(true);
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram.locator('.diagram-stage svg')).toBeVisible({ timeout: 30000 });
    await expect(diagram).toHaveAttribute('data-ready', 'true');
    await diagram.getByRole('button', { name: '放大流程图', exact: true }).click();
    await expect(diagram.locator('.diagram-stage')).toHaveAttribute('style', /width: 125%/);
    await diagram.getByRole('button', { name: '缩小流程图', exact: true }).click();
    await diagram.getByRole('button', { name: '还原', exact: true }).click();
    await expect(diagram.locator('.diagram-stage')).toHaveAttribute('style', /width: 100%/);
    const original = diagram.locator('.widget-source');
    const wasOpen = await original.evaluate(element => (element as HTMLDetailsElement).open);
    await diagram.getByRole('button', { name: '原文', exact: true }).click();
    await expect(original).toHaveJSProperty('open', !wasOpen);
    if (wasOpen) await diagram.getByRole('button', { name: '原文', exact: true }).click();
    await expect(original).toHaveJSProperty('open', true);
    await expect(diagram.locator('code')).toContainText('flowchart LR');
  });

  test('interactive charts switch series, announce focused points and retain the complete data table', async ({ page }) => {
    await page.goto('/lab/');
    const chart = page.locator('#lab-chart .chart-widget');
    const legend = chart.getByRole('group', { name: '切换图表数据系列' });
    const initial = await chart.locator('.chart-point').count();
    expect(initial).toBe(10);
    await legend.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(legend.getByRole('button', { name: '阅读', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(chart.locator('.chart-point')).toHaveCount(initial / 2);
    await legend.getByRole('button', { name: '实践', exact: true }).click();
    await expect(chart).toContainText('所有系列已隐藏');
    await legend.getByRole('button', { name: '阅读', exact: true }).click();
    const point = chart.locator('.chart-point').first();
    await point.focus();
    await expect(chart.locator('.chart-reading')).toHaveText((await point.getAttribute('aria-label'))!);
    await chart.locator('.chart-data summary').click();
    await expect(chart.getByRole('table')).toBeVisible();
    await expect(chart.getByRole('columnheader', { name: '实践', exact: true })).toBeVisible();
  });

  test('the lab copies portable Markdown and exposes real motion controls and callouts', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/lab/');
    await expect(page.locator('.lab-callouts .content-callout')).toHaveCount(3);
    await page.locator('[data-copy-template="chart"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^```chart\n/);
    await expect(page.locator('a[href="/manage/?template=chart"]')).toBeVisible();
    await page.getByRole('button', { name: '光幕', exact: true }).click();
    await expect(page.locator('#lab-motion')).toHaveAttribute('data-mode', 'scan');
    await expect(page.getByRole('button', { name: '光幕', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '呼吸', exact: true }).click();
    await expect(page.locator('#lab-motion')).toHaveAttribute('data-mode', 'breathe');
    await page.locator('#toggle-lab-motion').click();
    await expect(page.locator('#lab-motion')).toHaveClass(/motion-paused/);
    await page.locator('#toggle-lab-motion').click();
    await expect(page.locator('#lab-motion')).not.toHaveClass(/motion-paused/);
  });

  test('the command palette performs theme and navigation actions using only the keyboard', async ({ page }) => {
    await page.goto('/');
    const initial = await page.locator('html').getAttribute('data-theme');
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog');
    const query = dialog.getByRole('searchbox', { name: '全文搜索' });
    await query.fill('> 主题');
    await expect(dialog.getByRole('button', { name: /切换主题/ })).toBeVisible();
    await query.press('ArrowDown');
    await expect(dialog.getByRole('button', { name: /切换主题/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', initial === 'dark' ? 'light' : 'dark');
    await page.keyboard.press('ControlOrMeta+k');
    await query.fill('> 实验');
    await expect(dialog.getByRole('link', { name: /内容实验室/ })).toBeVisible();
    await query.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/lab\/$/);
  });

  test('the command palette drops a stale continue-reading action after the article becomes read', async ({ page }) => {
    await page.context().route('**/api/reading-state', route => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, message: 'Reading sync is unavailable in this local-only test.' }),
    }));
    await page.goto(example + '?examples=1');
    await page.locator('#article-body h2').last().scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')['build-a-learning-system']?.progress || 0)).toBeGreaterThan(20);
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: '在知识里，找一点灵感' });
    await expect(dialog.getByRole('link', { name: /继续阅读/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#mark-read').click();
    await expect(page.locator('#mark-read')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('link', { name: /继续阅读/ })).toHaveCount(0);
  });

  test('the homepage keeps diagram engines lazy and all content requests on the same origin', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const requests: string[] = [];
    page.on('request', request => requests.push(request.url()));
    await page.goto('/?examples=1', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: /让知识生长/ })).toBeVisible();
    expect(requests.filter(url => /mermaid(?:\.core)?[^/]*\.(?:js|ts)(?:\?|$)|mermaid_dist/i.test(url))).toEqual([]);
    await page.goto('/lab/');
    await page.locator('#lab-diagram .diagram-widget').scrollIntoViewIfNeeded();
    await expect(page.locator('#lab-diagram .diagram-widget[data-ready="true"] svg')).toBeVisible({ timeout: 30000 });
    const origin = new URL(baseURL!).origin;
    expect(requests.filter(url => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([]);
  });

  test('reduced motion and every upgraded layout remain usable without horizontal overflow', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const path of ['/?examples=1', '/lab/', example]) {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `No horizontal overflow on ${path}` }).toBeLessThanOrEqual(1);
    }
    await page.goto('/lab/');
    await expect(page.locator('#lab-motion')).toHaveClass(/motion-paused/);
    expect(await page.locator('.motion-core').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await page.getByRole('button', { name: '光幕', exact: true }).click();
    await expect(page.locator('#lab-motion')).toHaveAttribute('data-mode', 'scan');
  });
});

test.describe('real accelerated writing and content publishing', () => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET && process.env.BLOG_TEST_LOCAL_AUTH !== '1', 'Requires an explicitly authorized deployment with the persistent document API.');

  test('the new-document action creates one real draft and refreshing never repeats creation', async ({ page, content }) => {
    let creations = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/documents' && request.method() === 'POST') creations++; });
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST');
    await page.goto('/manage/?new=1');
    const document = await unwrap<DocumentDetail>(await created); content.track(document);
    await expect(page).toHaveURL(new RegExp('/manage/\\?id=' + document.id + '$'));
    const title = uniqueName('一键新建');
    await page.getByLabel('文档标题', { exact: true }).fill(title);
    await expect(page.locator('#save-status')).toContainText('已保存');
    await page.reload();
    await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue(title);
    expect(creations).toBe(1);
  });

  test('a lab template becomes a saved draft, a real preview and a published interactive article', async ({ page, content }) => {
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST');
    await page.goto('/manage/?template=chart');
    const document = await unwrap<DocumentDetail>(await created); content.track(document);
    await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(/```chart/);
    await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(/演示模板/);
    const title = uniqueName('交互模板发布');
    await page.getByLabel('文档标题', { exact: true }).fill(title);
    await expect(page.locator('#save-status')).toContainText('已保存');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#document-preview .chart-widget svg')).toBeVisible();
    await page.locator('#publish-document').click();
    await expect.poll(async () => (await content.get(document.id)).status).toBe('published');
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator('#live-title')).toHaveText(title);
    await expect(page.locator('#article-body .chart-widget svg')).toBeVisible();
    await page.getByRole('group', { name: '切换图表数据系列' }).getByRole('button', { name: '阅读', exact: true }).click();
    await expect(page.locator('#article-body .chart-point')).toHaveCount(5);
  });

  test('real reading enhances safe diagram and callout content while invalid definitions stay readable', async ({ page, content }) => {
    const source = ['## 动态内容验收', '', '> [!TIP]', '> 这里是测试创建的可恢复原文。', '', '```mermaid', 'flowchart LR', '  A[提问] --> B[验证]', '```', '', '```chart', '{"title":"broken","labels":["one"],"series":[{"name":"x","values":["not-a-number"]}]}', '```'].join('\n');
    let document = await content.create(sampleContent('动态内容安全降级', source));
    document = await content.action(document, 'publish');
    await page.goto(`/articles/${document.id}/`);
    await page.locator('#article-body .diagram-widget').scrollIntoViewIfNeeded();
    await expect(page.locator('#article-body .diagram-widget[data-ready="true"] svg')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#article-body .callout-tip')).toContainText('可恢复原文');
    const invalid = page.locator('#article-body .chart-widget');
    await expect(invalid.locator('.widget-error')).toBeVisible();
    await expect(invalid.locator('.widget-source')).toHaveAttribute('open', '');
    await expect(invalid.locator('code')).toContainText('not-a-number');
  });

  test('diagram recovery flushes an unsaved draft before reloading and never creates another document', async ({ page, content }) => {
    test.setTimeout(60000);
    const definition = ['## 预览刷新验收', '', '```mermaid', 'flowchart LR', '  A[记录] --> B[验证]', '```'].join('\n');
    const document = await content.create(sampleContent('安全刷新草稿', definition));
    let failedOnce = false;
    let creations = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/documents' && request.method() === 'POST') creations++; });
    await page.route(/(?:mermaid\.core[^/]*\.js|\/mermaid\.js)(?:\?.*)?$/, async route => {
      if (!failedOnce) { failedOnce = true; await route.fulfill({ status: 503, contentType: 'application/javascript', body: '/* temporary QA failure */' }); }
      else await route.continue();
    });
    await page.goto(`/manage/?id=${document.id}`);
    await page.getByRole('button', { name: '对照预览', exact: true }).click();
    await page.locator('#document-preview .diagram-widget').scrollIntoViewIfNeeded();
    const recovery = page.getByRole('button', { name: '刷新页面并重试流程图', exact: true });
    await expect(recovery).toBeVisible({ timeout: 30000 });
    expect(failedOnce).toBe(true);

    let saveStarted = false;
    let releaseSave!: () => void;
    const holdSave = new Promise<void>(resolve => { releaseSave = resolve; });
    await page.route(`**/api/documents/${document.id}`, async route => {
      if (route.request().method() === 'PUT') { saveStarted = true; await holdSave; }
      await route.continue();
    });
    let mainNavigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainNavigations++; });
    const marker = uniqueName('刷新前未保存内容');
    const changed = definition + '\n\n' + marker;
    const source = page.getByLabel('Markdown 正文', { exact: true });
    await source.fill(changed);
    const reload = page.waitForNavigation({ waitUntil: 'load' });
    const clicked = recovery.click();
    try {
      await expect.poll(() => saveStarted).toBe(true);
      expect(mainNavigations, 'Reload must wait while the real draft save is unresolved').toBe(0);
    } finally { releaseSave(); }
    await clicked; await reload;
    await expect(source).toHaveValue(changed);
    expect((await content.get(document.id)).source).toBe(changed);
    expect(creations).toBe(0);
    await page.getByRole('button', { name: '对照预览', exact: true }).click();
    const diagram = page.locator('#document-preview .diagram-widget');
    await diagram.scrollIntoViewIfNeeded();
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 30000 });
    await expect(diagram).toHaveAttribute('data-ready', 'true');
  });

  test('paste uploads an actual image, keyboard insertion works and writing focus leaves plain typing alone', async ({ page, content }) => {
    const document = await content.create(sampleContent('快速写作', ''));
    await page.goto(`/manage/?id=${document.id}`);
    const source = page.getByLabel('Markdown 正文', { exact: true });
    await source.fill('/ta');
    const menu = page.getByRole('menu', { name: '可插入的内容块' });
    await expect(menu).toBeVisible();
    await source.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(source).toHaveValue(/\|/);
    const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/assets' && response.request().method() === 'POST');
    const intercepted = await source.evaluate((textarea, bytes) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'qa-pasted.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event); return event.defaultPrevented;
    }, [...tinyPNG]);
    expect(intercepted).toBe(true);
    expect((await uploaded).status()).toBe(200);
    await expect(source).toHaveValue(/!\[[^\]]*\]\(\/api\/assets\/[a-f0-9]{64}\.png\)/);
    await expect(page.locator('#save-status')).toContainText('已保存');
    expect((await content.get(document.id)).source).toContain('/api/assets/');
    const normalPastePrevented = await source.evaluate(textarea => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'ordinary text');
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event); return event.defaultPrevented;
    });
    expect(normalPastePrevented).toBe(false);
    await source.press('End'); await source.press('f');
    await expect(page.locator('body')).not.toHaveClass(/writing-focus/);
    await expect(page.locator('#save-status')).toContainText('已保存');
    await page.getByRole('button', { name: '专注写作', exact: true }).click();
    await expect(page.locator('body')).toHaveClass(/writing-focus/);
    await page.keyboard.press('Escape');
    await expect(page.locator('body')).not.toHaveClass(/writing-focus/);
  });
});
