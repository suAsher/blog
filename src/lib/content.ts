import { getCollection, type CollectionEntry } from 'astro:content';
import type { SearchArticle } from './search';

export async function getArticles(): Promise<CollectionEntry<'articles'>[]> {
  const entries = await getCollection('articles');
  return [...entries].sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export function readingMinutes(body: string): number {
  const characters = body.replace(/\s+/gu, '').length;
  return Math.max(1, Math.ceil(characters / 350));
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '.');
}

export function toSearchArticle(entry: CollectionEntry<'articles'>): SearchArticle {
  return {
    id: entry.id,
    title: entry.data.title,
    description: entry.data.description,
    tags: [...entry.data.tags],
    category: entry.data.category,
    date: entry.data.date.toISOString().slice(0, 10),
    body: entry.body ?? '',
    cover: entry.data.cover,
    readingMinutes: readingMinutes(entry.body ?? ''),
    demo: entry.data.demo,
  };
}
