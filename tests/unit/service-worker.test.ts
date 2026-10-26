import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { renderServiceWorker } from '../../src/build/pwa-integration.mjs';

const origin = 'https://knowledge.test';
const template = readFileSync(new URL('../../public/sw-template.txt', import.meta.url), 'utf8');

function workerHarness() {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = { put: vi.fn(), match: vi.fn() };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    delete: vi.fn().mockResolvedValue(true),
    keys: vi.fn().mockResolvedValue([]),
  };
  const fetch = vi.fn();
  class BrowserRequest extends Request {
    constructor(input: string, init?: RequestInit) { super(new URL(input, origin), init); }
  }
  runInNewContext(renderServiceWorker('test-policy', ['/offline/', '/_astro/offline.js'], template), {
    URL, Request: BrowserRequest, fetch, caches,
    Response: { error: () => ({ networkError: true }) },
    self: {
      location: { origin }, clients: { claim: vi.fn() }, skipWaiting: vi.fn(),
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    },
  });
  return { listeners, fetch, cache, caches };
}

describe('generated service-worker behavior', () => {
  it('rejects login redirects during installation and removes a partial new cache', async () => {
    const worker = workerHarness();
    worker.fetch
      .mockResolvedValueOnce({ ok: true, type: 'basic', url: `${origin}/offline/` })
      .mockResolvedValueOnce({ ok: true, type: 'basic', url: `${origin}/login/` });
    let installation: Promise<unknown> | undefined;
    worker.listeners.get('install')!({ waitUntil: (task: Promise<unknown>) => { installation = task; } });
    await expect(installation).rejects.toThrow('Unsafe offline shell response');
    expect(worker.cache.put).toHaveBeenCalledTimes(1);
    expect(worker.cache.put.mock.calls[0][0]).toBe('/offline/');
    expect(worker.caches.delete).toHaveBeenCalledWith('asher-offline-shell-test-policy');
    for (const [request] of worker.fetch.mock.calls) {
      expect(request.redirect).toBe('error');
      expect(request.credentials).toBe('same-origin');
    }
  });

  it.each(['/api', '/api/documents', '/auth/logout', '/login/', 'https://external.test/'])('leaves %s entirely to the network', path => {
    const worker = workerHarness();
    const respondWith = vi.fn();
    worker.listeners.get('fetch')!({
      request: { method: 'GET', mode: 'navigate', url: new URL(path, origin).href }, respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
    expect(worker.cache.match).not.toHaveBeenCalled();
  });

  it.each([401, 302, 403, 503])('preserves an online %i response without offline fallback', async status => {
    const worker = workerHarness();
    const response = { status };
    worker.fetch.mockResolvedValue(response);
    let result: Promise<unknown> | undefined;
    worker.listeners.get('fetch')!({
      request: { method: 'GET', mode: 'navigate', url: `${origin}/articles/private/` },
      respondWith: (task: Promise<unknown>) => { result = task; },
    });
    expect(await result).toBe(response);
    expect(worker.caches.open).not.toHaveBeenCalled();
  });

  it('uses only the active content-free shell when the network actually fails', async () => {
    const worker = workerHarness();
    const shell = { contentFreeShell: true };
    worker.fetch.mockRejectedValue(new TypeError('offline'));
    worker.cache.match.mockResolvedValue(shell);
    let result: Promise<unknown> | undefined;
    worker.listeners.get('fetch')!({
      request: { method: 'GET', mode: 'navigate', url: `${origin}/articles/private/` },
      respondWith: (task: Promise<unknown>) => { result = task; },
    });
    expect(await result).toBe(shell);
    expect(worker.caches.open).toHaveBeenCalledWith('asher-offline-shell-test-policy');
    expect(worker.cache.match).toHaveBeenCalledWith('/offline/');
    expect(worker.cache.put).not.toHaveBeenCalled();
  });
});
