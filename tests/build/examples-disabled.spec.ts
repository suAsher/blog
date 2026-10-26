import { test as authenticatedTest, expect } from '../e2e/fixtures';
import { ContentHarness, sampleContent } from '../e2e/content-helpers';

const exampleArticleIds = [
  'a-quieter-workspace',
  'build-a-learning-system',
  'notes-that-grow',
  'reading-source-code',
  'small-reliable-tools',
  'the-art-of-asking',
];

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || '');
    try { await use(content); } finally { await content.cleanup(); }
  },
});

test('an examples-disabled build excludes demo artifacts but serves real published content', async ({ page, context, content }) => {
  let document = await content.create(sampleContent(
    '禁用示例构建',
    '## 真实发布内容\n\n这份文档只存在于本次临时 QA 数据目录，用于验证关闭示例后真实内容仍可阅读。',
  ));
  document = await content.action(document, 'publish');

  const searchIndex = await context.request.get('/search-index.json');
  expect(searchIndex.status()).toBe(200);
  expect(await searchIndex.json()).toEqual([]);

  for (const id of exampleArticleIds) {
    expect((await context.request.get(`/articles/${id}/`)).status(), `Static example route ${id} must not exist`).toBe(404);
  }

  for (const path of ['/', '/articles/?examples=1', '/about/']) {
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-examples', 'off');
    await expect(page.locator('a[href*="examples=1"]')).toHaveCount(0);
  }

  await page.goto('/articles/?examples=1');
  await expect(page.locator('#article-results').getByRole('link', { name: document.title, exact: true })).toBeVisible();
  await expect(page.locator('#collection-disclaimer')).toBeHidden();
  await expect(page.getByText('把碎片知识，连成自己的系统', { exact: true })).toHaveCount(0);

  await page.goto(`/articles/${document.id}/`);
  await expect(page).toHaveURL(new RegExp(`/articles/${document.id}/$`));
  await expect(page.getByRole('heading', { level: 1, name: document.title })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-examples', 'off');
});
