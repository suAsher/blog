import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    date: z.coerce.date(),
    tags: z.array(z.string().min(1)).default([]),
    category: z.string().min(1).optional(),
    cover: z.string().startsWith('/images/').default('/images/orbit.svg'),
    demo: z.boolean().default(false),
    featured: z.boolean().default(false),
  }),
});

export const collections = { articles };
