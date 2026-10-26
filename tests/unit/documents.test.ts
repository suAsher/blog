import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, documentHref, formatBytes, jsonRequest, requestJSON } from '../../src/lib/documents';
import { clearPrivateSession, releaseLogoutIntent } from '../../src/lib/auth-lifecycle';

afterEach(() => { vi.unstubAllGlobals(); releaseLogoutIntent(); });

describe('private document requests', () => {
  it('uses the current secure session without exposing credentials and unwraps real data', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { version: 2 } }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    expect(await requestJSON('/api/documents', jsonRequest('POST', { title: '笔记' }))).toEqual({ version: 2 });
    expect(fetch).toHaveBeenCalledWith('/api/documents', expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ title: '笔记' }) }));
  });

  it('keeps version conflicts and capacity errors actionable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, message: '文档已更新，请重新加载。', code: 'conflict' }), { status: 409 })));
    await expect(requestJSON('/api/documents/id')).rejects.toMatchObject({ status: 409, code: 'conflict', message: '文档已更新，请重新加载。' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, message: '服务器剩余容量不足。' }), { status: 507 })));
    await expect(requestJSON('/api/import')).rejects.toMatchObject({ status: 507, message: '服务器剩余容量不足。' });
  });

  it('sends expired sessions back to login while retaining the exact authoring destination', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/manage/', search: '?id=abc&tab=draft', assign });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(requestJSON('/api/documents')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login/?next=%2Fmanage%2F%3Fid%3Dabc%26tab%3Ddraft');
  });

  it('does not pretend a proxy HTML page or network failure saved the document', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>unavailable</html>', { status: 503 })));
    await expect(requestJSON('/api/documents')).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private internal error')));
    await expect(requestJSON('/api/documents')).rejects.toThrow('当前编辑不会丢失');
  });

  it('keeps a failed offline purge visible on the login page', async () => {
    const assign = vi.fn();
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    events.addEventListener('auth:clear', event => {
      (event as CustomEvent).detail.waitUntil(Promise.reject(new Error('device storage blocked')));
    });
    vi.stubGlobal('location', { pathname: '/articles/', search: '', assign });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(requestJSON('/api/documents')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login/?next=%2Farticles%2F&cleanup=incomplete');
  });

  it('does not let a late API expiry replace an explicit logout destination', async () => {
    vi.stubGlobal('document', new EventTarget());
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/articles/', search: '', assign });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await clearPrivateSession('logout');
    await expect(requestJSON('/api/documents')).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
    releaseLogoutIntent();
    await expect(requestJSON('/api/documents')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login/?next=%2Farticles%2F');
  });

  it('allows an intentional request cancellation to remain a cancellation', async () => {
    const aborted = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(requestJSON('/api/preview')).rejects.toBe(aborted);
  });

  it('provides a safe fallback when a failed API has no public message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 500 })));
    await expect(requestJSON('/api/documents')).rejects.toThrow('操作没有完成');
    expect(new ApiError('message', 409).name).toBe('ApiError');
  });
});

it('formats upload sizes and document paths without mixing them with server filesystem paths', () => {
  expect(formatBytes(-5)).toBe('0 B');
  expect(formatBytes(128)).toBe('128 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  expect(documentHref('space / 中文')).toBe('/articles/space%20%2F%20%E4%B8%AD%E6%96%87/');
});
