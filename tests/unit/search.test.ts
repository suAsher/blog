import { describe, expect, it } from 'vitest';
import { getCategories, getTags, searchArticles, type SearchArticle } from '../../src/lib/search';

const article = (id: string, values: Partial<SearchArticle> = {}): SearchArticle => ({
  id,
  title: '阅读笔记',
  description: '思考与记录',
  date: '2026-10-20',
  tags: [],
  body: '',
  cover: '/images/demo.svg',
  readingMinutes: 5,
  demo: true,
  ...values,
});

describe('full-text article search', () => {
  it('finds Chinese words appearing only in the full article body', () => {
    const items = [article('first'), article('body', { body: '实验完成后，记录观察窗口与测量误差。' })];
    expect(searchArticles(items, '观察窗口').map(({ id }) => id)).toEqual(['body']);
  });

  it('requires every query token and ranks title matches above body matches', () => {
    const items = [
      article('body', { body: '缓存 Cache 让阅读更快' }),
      article('partial', { title: '缓存' }),
      article('title', { title: '缓存与 CACHE', body: '示例' }),
    ];
    expect(searchArticles(items, ' 缓存   cache ').map(({ id }) => id)).toEqual(['title', 'body']);
    expect(items.map(({ id }) => id)).toEqual(['body', 'partial', 'title']);
  });

  it('matches descriptions and tags without depending on ASCII case or full-width forms', () => {
    const items = [
      article('description', { description: 'A TypeScript example' }),
      article('tag', { tags: ['TypeScript'] }),
      article('miss'),
    ];
    expect(searchArticles(items, 'ＴＹＰＥＳＣＲＩＰＴ').map(({ id }) => id)).toEqual(['description', 'tag']);
  });

  it('combines content-driven tag and category filters with a query', () => {
    const items = [
      article('both', { body: '测试', tags: ['方法'], category: '学习笔记' }),
      article('other-category', { body: '测试', tags: ['方法'], category: '实验记录' }),
      article('other-tag', { body: '测试', tags: ['随想'], category: '学习笔记' }),
    ];
    expect(searchArticles(items, '测试', '方法', '学习笔记').map(({ id }) => id)).toEqual(['both']);
    expect(searchArticles(items, '', '不存在')).toEqual([]);
  });

  it('preserves input order for an empty query and stable ties', () => {
    const items = [article('later', { title: '代码' }), article('earlier', { title: '代码' })];
    expect(searchArticles(items, '  ').map(({ id }) => id)).toEqual(['later', 'earlier']);
    expect(searchArticles(items, '代码').map(({ id }) => id)).toEqual(['later', 'earlier']);
    expect(searchArticles([], '代码')).toEqual([]);
  });

  it('treats punctuation literally instead of compiling an untrusted regular expression', () => {
    const items = [article('literal', { body: '示例 [a+b] 与 C++' }), article('other')];
    expect(searchArticles(items, '[a+b]').map(({ id }) => id)).toEqual(['literal']);
    expect(searchArticles(items, '<script>')).toEqual([]);
  });
});

describe('content-derived facets', () => {
  const items = [
    article('one', { tags: ['方法', '代码', '代码'], category: '实验' }),
    article('two', { tags: ['方法', '阅读'], category: '实验' }),
    article('three', { tags: ['代码'], category: '随笔' }),
    article('four'),
  ];

  it('counts an article once for each tag and sorts by count then name', () => {
    const tags = getTags(items);
    expect(tags.filter(({ count }) => count === 2).map(({ name }) => name)).toEqual(
      ['方法', '代码'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    );
    expect(tags.at(-1)).toEqual({ name: '阅读', count: 1 });
    expect(getTags([])).toEqual([]);
  });

  it('derives categories only from content and skips missing categories', () => {
    expect(getCategories(items)).toEqual([{ name: '实验', count: 2 }, { name: '随笔', count: 1 }]);
    expect(getCategories([])).toEqual([]);
  });
});
