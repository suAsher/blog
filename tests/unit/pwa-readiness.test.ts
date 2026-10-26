import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForOfflineShellReady } from '../../src/lib/pwa-readiness';

const origin = 'https://knowledge.test';
const registration = (script = `${origin}/sw.js`, scope = `${origin}/`) => ({
  scope, active: { state: 'activated', scriptURL: script },
});

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('offline entry readiness', () => {
  it('does not claim offline support when the platform lacks service workers', async () => {
    vi.stubGlobal('navigator', {});
    await expect(waitForOfflineShellReady()).rejects.toThrow('不支持');
  });

  it('accepts an active exact-origin root-scoped worker', async () => {
    const getRegistration = vi.fn().mockResolvedValue(registration());
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
    vi.stubGlobal('location', { origin });
    await expect(waitForOfflineShellReady()).resolves.toBeUndefined();
    expect(getRegistration).toHaveBeenCalledWith('/');
  });

  it('registers and awaits activation before reporting success', async () => {
    const active = registration();
    const register = vi.fn().mockResolvedValue({ active: null });
    vi.stubGlobal('navigator', { serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue(undefined), register,
      ready: Promise.resolve(active),
    } });
    vi.stubGlobal('location', { origin });
    await waitForOfflineShellReady();
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it.each([
    ['https://external.test/sw.js', `${origin}/`],
    [`${origin}/sw.js?old=1`, `${origin}/`],
    [`${origin}/sw.js`, `${origin}/another-app/`],
  ])('rejects an unexpected script or scope: %s %s', async (script, scope) => {
    vi.stubGlobal('navigator', { serviceWorker: {
      getRegistration: vi.fn().mockResolvedValue(registration(script, scope)),
    } });
    vi.stubGlobal('location', { origin });
    await expect(waitForOfflineShellReady()).rejects.toThrow('来源不可信');
  });

  it('bounds stalled platform activation and removes its timer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { serviceWorker: {
      getRegistration: () => new Promise(() => {}),
    } });
    const result = expect(waitForOfflineShellReady(100)).rejects.toThrow('尚未准备好');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
