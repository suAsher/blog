import { getArticles, toSearchArticle } from '../lib/content';
export const GET = async () => new Response(JSON.stringify((await getArticles()).map(toSearchArticle)), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
