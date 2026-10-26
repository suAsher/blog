import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPrivateSession, releaseLogoutIntent } from '../../src/lib/auth-lifecycle';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); releaseLogoutIntent(); });

describe('private session cleanup', () => {
  it('works without a browser document', async () => {
    await expect(clearPrivateSession('expired')).resolves.toBe(true);
  });

  it('waits for every registered purge before allowing navigation', async () => {
    const order: string[] = [];
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    events.addEventListener('auth:clear', event => {
      const detail = (event as CustomEvent).detail;
      expect(detail.reason).toBe('logout');
      detail.waitUntil(Promise.resolve().then(() => { order.push('purged'); }));
    });
    expect(await clearPrivateSession('logout')).toBe(true);
    order.push('navigate');
    expect(order).toEqual(['purged', 'navigate']);
  });

  it('lets other cleanup handlers finish when one fails', async () => {
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    let cleaned = false;
    events.addEventListener('auth:clear', event => {
      const detail = (event as CustomEvent).detail;
      detail.waitUntil(Promise.reject(new Error('storage unavailable')));
      detail.waitUntil(Promise.resolve().then(() => { cleaned = true; }));
    });
    expect(await clearPrivateSession('expired')).toBe(false);
    expect(cleaned).toBe(true);
  });

  it('coalesces concurrent expiry requests and bounds blocked device storage', async () => {
    vi.useFakeTimers();
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    const listener = vi.fn(event => {
      (event as CustomEvent).detail.waitUntil(new Promise(() => {}));
    });
    events.addEventListener('auth:clear', listener);
    const first = clearPrivateSession('expired');
    const second = clearPrivateSession('expired');
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await Promise.all([first, second])).toEqual([false, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates an in-flight expiry cleanup when the owner explicitly logs out', async () => {
    const events = new EventTarget();
    vi.stubGlobal('document', events);
    const reasons: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    events.addEventListener('auth:clear', event => {
      const detail = (event as CustomEvent).detail;
      reasons.push(detail.reason);
      detail.waitUntil(blocked);
    });
    const expiry = clearPrivateSession('expired');
    const logout = clearPrivateSession('logout');
    const duplicate = clearPrivateSession('logout');
    expect(reasons).toEqual(['expired', 'logout']);
    release();
    expect(await Promise.all([expiry, logout, duplicate])).toEqual([true, true, true]);
  });
});
