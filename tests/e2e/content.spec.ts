import { test as authenticatedTest, expect } from './fixtures';
import { establishSession } from './fixtures';
import type { DocumentDetail, ImportReport } from '../../src/lib/documents';
import { ContentHarness, contentOf, importForm, readTestZip, sampleContent, tinyPNG, uniqueName, unwrap } from './content-helpers';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || '');
    try { await use(content); } finally { await content.cleanup(); }
  },
});

test.describe('real document writing and import', () => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET, 'Requires an explicitly authorized deployment with the persistent document API.');

  test('the writing workspace creates, autosaves, previews and publishes a real document', async ({ page, content }) => {
    const title = uniqueName('站内写作');
    const keyword = uniqueName('仅在正文的检索词').replaceAll(' ', '');
    await page.goto('/manage/');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/documents' && response.request().method() === 'POST');
    await page.locator('#new-document').click();
    content.track(await unwrap<DocumentDetail>(await created));
    await page.getByLabel('文档标题', { exact: true }).fill(title);
    await page.getByLabel('Markdown 正文', { exact: true }).fill(`## 一次真正的写作\n\n${keyword}\n\n> 测试创建，完成后删除。`);
    await expect(page.locator('#save-status')).toContainText('已保存');
    await page.reload();
    await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue(title);
    await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(new RegExp(keyword));
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.getByRole('heading', { name: '一次真正的写作', exact: true })).toBeVisible();
    await page.locator('#publish-document').click();
    await expect.poll(async () => (await content.list({ status: 'published', q: keyword })).total).toBe(1);
    await page.goto('/articles/');
    await page.getByRole('searchbox', { name: '搜索文章全文' }).fill(keyword);
    await expect(page.locator('#article-results').getByRole('link', { name: title, exact: true })).toBeVisible();
    await page.locator('#article-results').getByRole('link', { name: title, exact: true }).click();
    await expect(page.locator('#live-title')).toHaveText(title);
    await expect(page.locator('#article-body')).toContainText(keyword);
  });

  test('saving a published document keeps its live snapshot until an explicit republish', async ({ content }) => {
    let document = await content.create(sampleContent('发布快照', '## 已发布版本\n\n原来的线上正文。'));
    document = await content.action(document, 'publish');
    document = await content.save(document, { source: '## 尚未发布的修改\n\n这一段只在工作副本出现。' });
    expect(document.hasUnpublishedChanges).toBe(true);
    expect((await content.get(document.id, true)).source).toContain('原来的线上正文');
    expect((await content.get(document.id)).source).toContain('这一段只在工作副本出现');
    document = await content.action(document, 'publish');
    expect(document.hasUnpublishedChanges).toBe(false);
    expect((await content.get(document.id, true)).source).toContain('这一段只在工作副本出现');
  });

  test('full-text search and metadata filters find published content but exclude drafts', async ({ content, page }) => {
    const marker = uniqueName('全文匹配').replaceAll(' ', '');
    const tag = uniqueName('自定义标签');
    let published = await content.create({ ...sampleContent('全文文章'), tags: [tag], category: '测试生成分类', source: `## 正文\n\n只有这里包含 ${marker} 和第二个关键词。` });
    published = await content.action(published, 'publish');
    await content.create({ ...sampleContent('不公开草稿'), source: marker });
    const matches = await content.list({ status: 'published', q: marker + ' 第二个关键词', tag, category: '测试生成分类' });
    expect(matches.documents.map(document => document.id)).toEqual([published.id]);
    expect(matches.tags.some(facet => facet.name === tag)).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: '搜索文章', exact: true }).click();
    await page.getByRole('searchbox', { name: '全文搜索' }).fill(marker);
    await expect(page.getByRole('dialog').getByRole('link', { name: new RegExp(published.title) })).toBeVisible();
  });

  test('a real reader supports code copy, image, table, progress, bookmark and focus mode', async ({ page, context, content }) => {
    const image = await content.uploadImage();
    const paragraphs = Array.from({ length: 18 }, (_, index) => `这是一段用于检验中文长文阅读位置的内容 ${index}。`.repeat(12)).join('\n\n');
    const source = `## 开始阅读\n\n\`\`\`typescript\nconst realDocument = true;\n\`\`\`\n\n| 项目 | 结果 |\n| --- | --- |\n| 保存 | 持久化 |\n\n![QA配图](${image})\n\n${paragraphs}\n\n## 回顾这一节\n\n已经读到文末。`;
    let document = await content.create({ ...sampleContent('真实阅读', source), cover: image });
    document = await content.action(document, 'publish');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator('#live-title')).toHaveText(document.title);
    await page.getByRole('button', { name: '复制代码', exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('const realDocument = true');
    await expect(page.locator('#article-body pre code span')).not.toHaveCount(0);
    await expect(page.getByRole('region', { name: '文章表格，可左右滚动' })).toBeAttached();
    await expect.poll(() => page.getByRole('img', { name: 'QA配图', exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `取消收藏：${document.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (await page.locator('.mobile-toc').isVisible()) {
      await page.locator('.mobile-toc summary').click();
      await page.getByRole('navigation', { name: '移动端文章目录', exact: true }).getByRole('link', { name: '回顾这一节', exact: true }).click();
    } else {
      await page.getByRole('navigation', { name: '文章目录', exact: true }).getByRole('link', { name: '回顾这一节', exact: true }).click();
    }
    await expect(page).toHaveURL(/#/);
    await expect.poll(async () => Number((await page.locator('#reading-percent').textContent())?.replace('%', ''))).toBeGreaterThan(40);
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: '退出专注 Esc' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.site-header')).toBeVisible();
    await page.goto('/library/');
    await expect(page.locator('#library-results').getByRole('link', { name: document.title, exact: true })).toBeVisible();
  });

  test('batch import preserves folder image links, reports missing images and creates drafts', async ({ content }) => {
    const title = uniqueName('目录导入');
    const marker = uniqueName('TXT导入');
    const report = await content.import([
      { path: 'qa-docs/notes/start.md', buffer: Buffer.from(`---\ntitle: "${title}"\ndescription: "测试导入摘要"\ntags: [导入验收]\n---\n\n## 导入正文\n\n![本地配图](../images/pixel.png)\n\n![缺少配图](../images/missing.png)`) },
      { path: 'qa-docs/plain.txt', buffer: Buffer.from(marker + '\n\n纯文本也应保留中文内容。') },
      { path: 'qa-docs/images/pixel.png', buffer: tinyPNG, mimeType: 'image/png' },
    ]);
    expect(report.imported).toHaveLength(2);
    expect(report.imported.every(document => document.status === 'draft')).toBe(true);
    expect(report.unresolvedImages.some(item => item.path.includes('missing.png'))).toBe(true);
    const imported = report.imported.find(document => document.title === title);
    expect(imported).toBeDefined();
    const document = await content.get(imported!.id);
    expect(document.html).toMatch(/src="\/api\/assets\/[a-f0-9]{64}\.png"/);
    expect(document.source).toContain('导入正文');
    expect((await content.list({ status: 'published', q: title })).total).toBe(0);
    expect((await content.list({ status: 'draft', q: marker })).documents.length).toBe(1);
  });

  test('the workspace can upload an actual selected folder and reopen its imported draft', async ({ page, content }) => {
    const folder = await mkdtemp(join(tmpdir(), 'asher-qa-docs-'));
    const title = uniqueName('页面目录上传');
    try {
      await mkdir(join(folder, 'images'));
      await writeFile(join(folder, 'document.md'), `---\ntitle: "${title}"\n---\n\n## 文件夹正文\n\n![目录配图](images/pixel.png)`);
      await writeFile(join(folder, 'images', 'pixel.png'), tinyPNG);
      await page.goto('/manage/?import=1');
      await expect(page.locator('#import-dialog')).toBeVisible();
      await page.locator('#import-folder').setInputFiles(folder);
      const imported = page.waitForResponse(response => new URL(response.url()).pathname === '/api/import' && response.request().method() === 'POST');
      await page.locator('#confirm-import').click();
      const report = await unwrap<ImportReport>(await imported);
      report.imported.forEach(document => content.track(document));
      expect(report.imported).toHaveLength(1);
      expect(report.unresolvedImages).toHaveLength(0);
      await page.goto(`/manage/?id=${report.imported[0].id}`);
      await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue(title);
      await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(/文件夹正文/);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  test('Markdown and ZIP exports preserve source, metadata and the associated image', async ({ content, context }) => {
    const title = uniqueName('可迁移导出');
    const report = await content.import([
      { path: 'notes/export.md', buffer: Buffer.from(`---\ntitle: "${title}"\ntags: [可迁移]\n---\n\n## 导出正文\n\n![附件](../images/pixel.png)`) },
      { path: 'images/pixel.png', buffer: tinyPNG, mimeType: 'image/png' },
    ]);
    const id = report.imported[0].id;
    const markdown = await context.request.get(`/api/documents/${id}/export`);
    expect(markdown.status()).toBe(200);
    expect(markdown.headers()['content-disposition']).toContain('attachment');
    const source = await markdown.text();
    expect(source).toContain(title);
    expect(source).toContain('导出正文');
    expect(source).toMatch(/^---\r?\n/);
    const bundle = await context.request.get(`/api/documents/${id}/export?format=zip`);
    expect(bundle.status()).toBe(200);
    const files = readTestZip(await bundle.body());
    expect([...files.keys()].some(name => name.endsWith('.md'))).toBe(true);
    expect([...files.values()].some(bytes => bytes.equals(tinyPNG))).toBe(true);
    expect([...files.values()].some(bytes => bytes.toString('utf8').includes('导出正文'))).toBe(true);
  });

  test('a saved draft persists across page reload and an independently authenticated browser context', async ({ page, browser, baseURL, content }) => {
    const document = await content.create(sampleContent('持久化草稿', '## 不依赖浏览器缓存\n\n写作内容应保存在服务器。'));
    await page.goto(`/manage/?id=${document.id}`);
    await expect(page.getByLabel('Markdown 正文', { exact: true })).toHaveValue(/写作内容应保存在服务器/);
    await page.reload();
    await expect(page.getByLabel('文档标题', { exact: true })).toHaveValue(document.title);
    const independent = await browser.newContext({ baseURL });
    try {
      await establishSession(independent, baseURL);
      const response = await independent.request.get(`/api/documents/${document.id}`);
      expect((await unwrap<DocumentDetail>(response)).source).toContain('写作内容应保存在服务器');
    } finally { await independent.close(); }
    expect((await content.list({ status: 'published', q: document.title })).total).toBe(0);
  });

  test('unpublish, trash, restore and permanent deletion follow safe lifecycle rules', async ({ context, content }) => {
    let document = await content.create(sampleContent('生命周期'));
    document = await content.action(document, 'publish');
    document = await content.action(document, 'unpublish');
    expect(document.status).toBe('draft');
    expect((await context.request.get(`/api/documents/${document.id}?view=published`)).status()).toBe(404);
    document = await content.action(document, 'publish');
    document = await content.action(document, 'trash');
    expect(document.status).toBe('trash');
    expect((await content.list({ status: 'published', q: document.title })).total).toBe(0);
    document = await content.action(document, 'restore');
    expect(document.status).toBe('draft');
    expect((await context.request.get(`/api/documents/${document.id}?view=published`)).status()).toBe(404);
    expect((await context.request.delete(`/api/documents/${document.id}`, { headers: { Origin: content.origin }, data: { version: document.version } })).status()).toBe(409);
    document = await content.action(document, 'trash');
    expect((await context.request.delete(`/api/documents/${document.id}`, { headers: { Origin: content.origin }, data: { version: document.version } })).ok()).toBe(true);
    expect((await context.request.get(`/api/documents/${document.id}`)).status()).toBe(404);
  });

  test('the API rejects anonymous writes, cross-origin mutations and stale document versions', async ({ browser, context, baseURL, content }) => {
    const document = await content.create(sampleContent('并发与认证'));
    const stale = { ...contentOf(document), version: document.version };
    await content.save(document, { source: '新的工作副本，不能被旧版本覆盖。' });
    const conflict = await context.request.put(`/api/documents/${document.id}`, { headers: { Origin: content.origin }, data: stale });
    expect(conflict.status()).toBe(409);
    expect((await content.get(document.id)).source).toContain('不能被旧版本覆盖');
    const csrf = await context.request.put(`/api/documents/${document.id}`, { headers: { Origin: 'https://evil.invalid' }, data: stale });
    expect(csrf.status()).toBe(403);
    const anonymous = await browser.newContext({ baseURL });
    try {
      expect((await anonymous.request.get(`/api/documents/${document.id}`, { maxRedirects: 0 })).status()).toBe(401);
      expect((await anonymous.request.post('/api/documents', { headers: { Origin: content.origin }, data: sampleContent('匿名拒绝'), maxRedirects: 0 })).status()).toBe(401);
    } finally { await anonymous.close(); }
  });

  test('imports reject traversal, fake images and executable content while preserving safe Markdown', async ({ context, content }) => {
    const traversal = await context.request.post('/api/import', {
      headers: { Origin: content.origin }, multipart: importForm([{ path: '../outside.md', buffer: Buffer.from('must not be written') }]),
    });
    expect(traversal.status()).toBe(400);
    const fake = new FormData();
    fake.append('files', new Blob(['not a PNG'], { type: 'image/png' }), 'fake.png');
    const invalidImage = await context.request.post('/api/assets', { headers: { Origin: content.origin }, multipart: fake });
    expect(invalidImage.status()).toBeGreaterThanOrEqual(400);
    expect(invalidImage.status()).toBeLessThan(500);
    const executable = new FormData();
    executable.append('files', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'executable.svg');
    const rejectedSVG = await context.request.post('/api/assets', { headers: { Origin: content.origin }, multipart: executable });
    expect(rejectedSVG.status()).toBeGreaterThanOrEqual(400);
    expect(rejectedSVG.status()).toBeLessThan(500);
    const document = await content.create(sampleContent('安全Markdown', '## 安全正文\n\n<script>window.intruder=true</script>\n\n[恶意链接](javascript:alert(1))\n\n普通中文内容仍然保留。'));
    expect(document.html).not.toContain('<script');
    expect(document.html).not.toContain('href="javascript:');
    expect(document.html).toContain('普通中文内容仍然保留');
    const preview = await unwrap<{ html: string }>(await context.request.post('/api/preview', {
      headers: { Origin: content.origin }, data: { source: document.source, documentId: document.id },
    }));
    expect(preview.html).not.toContain('<script');
  });

  test('the writing workspace remains keyboard-accessible and fits the current device', async ({ page, content }) => {
    const document = await content.create(sampleContent('响应式写作'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/manage/?id=${document.id}`);
    const title = page.getByLabel('文档标题', { exact: true });
    await expect(title).toHaveValue(document.title);
    await title.focus();
    await expect(title).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => window.document.activeElement?.tagName)).not.toBe('BODY');
    const source = page.getByLabel('Markdown 正文', { exact: true });
    await source.fill('## 键盘写作\n\n本次编辑应自动保存。');
    await expect(page.locator('#save-status')).toContainText('已保存');
    await expect.poll(async () => (await content.get(document.id)).source).toContain('本次编辑应自动保存');
    expect(await page.evaluate(() => window.document.documentElement.scrollWidth - window.document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
