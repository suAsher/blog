/** A framework-independent search record, generated from Markdown at build time. */
export interface SearchArticle {
  id: string;
  title: string;
  description: string;
  tags: string[];
  category?: string;
  date: string;
  body: string;
  cover: string;
  readingMinutes: number;
  demo: boolean;
}

export interface ContentFacet {
  name: string;
  count: number;
}

const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN');

/** Match every whitespace-separated token, including Chinese substrings and code. */
export function searchArticles<T extends SearchArticle>(
  articles: readonly T[],
  query: string,
  tag = '',
  category = '',
): T[] {
  const tokens = normalize(query).trim().split(/\s+/u).filter(Boolean);
  const selectedTag = normalize(tag.trim());
  const selectedCategory = normalize(category.trim());

  return articles
    .filter((article) =>
      (!selectedTag || article.tags.some((value) => normalize(value) === selectedTag)) &&
      (!selectedCategory || normalize(article.category ?? '') === selectedCategory),
    )
    .map((article, index) => {
      const title = normalize(article.title);
      const description = normalize(article.description);
      const tags = normalize(article.tags.join(' '));
      const fullText = `${title}\n${description}\n${tags}\n${normalize(article.body)}`;
      return {
        article,
        index,
        matches: tokens.every((token) => fullText.includes(token)),
        titleMatches: tokens.filter((token) => title.includes(token)).length,
        descriptionMatches: tokens.filter((token) => description.includes(token)).length,
        tagMatches: tokens.filter((token) => tags.includes(token)).length,
      };
    })
    .filter(({ matches }) => matches)
    .sort((a, b) =>
      b.titleMatches - a.titleMatches ||
      b.descriptionMatches - a.descriptionMatches ||
      b.tagMatches - a.tagMatches ||
      a.index - b.index,
    )
    .map(({ article }) => article);
}

function countFacets(groups: readonly string[][]): ContentFacet[] {
  const uniqueGroups = groups.map((values) => [...new Set(values.filter(Boolean))]);
  const names = [...new Set(uniqueGroups.flat())];
  return names
    .map((name) => ({ name, count: uniqueGroups.filter((values) => values.includes(name)).length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
}

export function getTags(articles: readonly SearchArticle[]): ContentFacet[] {
  return countFacets(articles.map(({ tags }) => tags));
}

export function getCategories(articles: readonly SearchArticle[]): ContentFacet[] {
  return countFacets(articles.map(({ category }) => category ? [category] : []));
}
