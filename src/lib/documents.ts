import type { ContentFacet, SearchArticle } from './search';

export interface DocumentContent { title: string; description: string; date: string; tags: string[]; category: string; cover: string; source: string }
export interface DocumentSummary extends SearchArticle {
  status: 'draft' | 'published' | 'trash'; version: number;
  createdAt: string; updatedAt: string; publishedAt?: string; hasUnpublishedChanges: boolean;
}
export interface DocumentDetail extends DocumentSummary {
  source: string; html: string; headings: { depth: number; slug: string; text: string }[]; sourcePath?: string;
}
export interface Quota { usedBytes: number; freeBytes: number; reserveBytes: number; maxUploadBytes: number; maxImageBytes: number; maxSourceBytes: number }
export interface DocumentList {
  documents: DocumentSummary[]; total: number; tags: ContentFacet[]; categories: ContentFacet[];
  stats: { draft: number; published: number; trash: number }; quota: Quota;
}
export interface ImportReport {
  imported: DocumentSummary[]; skipped: { path: string; message: string }[];
  unresolvedImages: { document: string; path: string }[]; warnings: string[]; quota: Quota;
}
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); this.name = 'ApiError'; }
}
export async function requestJSON<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(path, { ...options, credentials: 'same-origin' }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ApiError('连接暂时不可用，请检查网络后重试。当前编辑不会丢失。', 0); }
  if (response.status === 401) {
    const next = location.pathname + location.search;
    location.assign(`/login/?next=${encodeURIComponent(next)}`);
    throw new ApiError('登录已过期，请重新登录。', 401);
  }
  let payload: { ok?: boolean; data?: T; message?: string; code?: string };
  try { payload = await response.json(); }
  catch { throw new ApiError('服务暂时不可用，请稍后重试。', response.status); }
  if (!response.ok || payload.ok !== true) throw new ApiError(payload.message || '操作没有完成，请稍后重试。', response.status, payload.code);
  return payload.data as T;
}
export function jsonRequest(method: string, data: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}
export const documentHref = (id: string) => `/articles/${encodeURIComponent(id)}/`;
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
