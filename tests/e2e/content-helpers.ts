import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { DocumentContent, DocumentDetail, DocumentList, ImportReport } from '../../src/lib/documents';

// These bytes are a generated test fixture, never a user-owned local image.
export const tinyPNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOY9eLcfwAHwANQNXXDHAAAAABJRU5ErkJggg==', 'base64');

export function uniqueName(label: string): string {
  return `QA ${label} ${randomUUID().slice(0, 8)}`;
}

export function contentOf(document: DocumentDetail): DocumentContent {
  const { title, description, date, tags, category, cover, source } = document;
  return { title, description, date, tags, category: category || '', cover, source };
}

export function sampleContent(label: string, source = '## 正文\n\n这是一份由自动化测试创建、完成后删除的文档。'): DocumentContent {
  return {
    title: uniqueName(label), description: '仅用于本次正式文档功能验收。', date: '2026-10-25',
    tags: ['QA验收'], category: 'QA临时内容', cover: '', source,
  };
}

export async function unwrap<T>(response: Pick<APIResponse, 'status' | 'json'>): Promise<T> {
  expect(response.status(), 'Content API should return a successful HTTP response').toBeGreaterThanOrEqual(200);
  expect(response.status(), 'Content API should return a successful HTTP response').toBeLessThan(300);
  const payload = await response.json() as { ok: boolean; data: T };
  expect(payload.ok).toBe(true);
  return payload.data;
}

export function importForm(files: { path: string; buffer: Buffer; mimeType?: string }[]): FormData {
  const form = new FormData();
  form.append('paths', JSON.stringify(files.map(file => file.path)));
  for (const file of files) {
    form.append('files', new Blob([new Uint8Array(file.buffer)], { type: file.mimeType || 'application/octet-stream' }), file.path.split('/').pop() || 'document.md');
  }
  return form;
}

export class ContentHarness {
  private readonly owned = new Set<string>();
  readonly origin: string;
  constructor(readonly request: APIRequestContext, baseURL: string) { this.origin = new URL(baseURL).origin; }

  track(document: Pick<DocumentDetail, 'id'>): void {
    expect(document.id).toMatch(/^[a-f0-9]{32}$/);
    this.owned.add(document.id);
  }

  async create(content: DocumentContent): Promise<DocumentDetail> {
    const document = await unwrap<DocumentDetail>(await this.request.post('/api/documents', {
      headers: { Origin: this.origin }, data: content,
    }));
    this.track(document);
    return document;
  }

  async get(id: string, published = false): Promise<DocumentDetail> {
    return unwrap<DocumentDetail>(await this.request.get(`/api/documents/${id}${published ? '?view=published' : ''}`));
  }

  async save(document: DocumentDetail, patch: Partial<DocumentContent>): Promise<DocumentDetail> {
    return unwrap<DocumentDetail>(await this.request.put(`/api/documents/${document.id}`, {
      headers: { Origin: this.origin }, data: { ...contentOf(document), ...patch, version: document.version },
    }));
  }

  async action(document: DocumentDetail, action: 'publish' | 'unpublish' | 'trash' | 'restore'): Promise<DocumentDetail> {
    return unwrap<DocumentDetail>(await this.request.post(`/api/documents/${document.id}/${action}`, {
      headers: { Origin: this.origin }, data: { version: document.version },
    }));
  }

  async list(params: Record<string, string> = {}): Promise<DocumentList> {
    return unwrap<DocumentList>(await this.request.get(`/api/documents?${new URLSearchParams({ limit: '1000', ...params })}`));
  }

  async import(files: { path: string; buffer: Buffer; mimeType?: string }[]): Promise<ImportReport> {
    const report = await unwrap<ImportReport>(await this.request.post('/api/import', {
      headers: { Origin: this.origin }, multipart: importForm(files),
    }));
    report.imported.forEach(document => this.track(document));
    return report;
  }

  async uploadImage(): Promise<string> {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(tinyPNG)], { type: 'image/png' }), 'qa-pixel.png');
    const data = await unwrap<{ assets: { url: string }[] }>(await this.request.post('/api/assets', {
      headers: { Origin: this.origin }, multipart: form,
    }));
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0].url).toMatch(/^\/api\/assets\/[a-f0-9]{64}\.png$/);
    return data.assets[0].url;
  }

  async cleanup(): Promise<void> {
    const failed: string[] = [];
    for (const id of this.owned) {
      try {
        const response = await this.request.get(`/api/documents/${id}`);
        if (response.status() === 404) continue;
        let document = await unwrap<DocumentDetail>(response);
        if (document.status !== 'trash') document = await this.action(document, 'trash');
        const removed = await this.request.delete(`/api/documents/${id}`, {
          headers: { Origin: this.origin }, data: { version: document.version },
        });
        if (removed.status() < 200 || removed.status() >= 300) failed.push(id);
      } catch { failed.push(id); }
    }
    expect(failed, 'Only documents created by this test must be removed after verification').toEqual([]);
  }
}

/** Read central-directory entries in a small generated ZIP, without extracting files. */
export function readTestZip(bytes: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('Export is not a ZIP archive.');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid export ZIP directory.');
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsafe path in exported ZIP.');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid export ZIP entry.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (!name.endsWith('/')) files.set(name, method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
