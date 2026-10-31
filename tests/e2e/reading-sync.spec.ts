import { test as authenticatedTest, expect, establishSession, submitRealLogin } from './fixtures';
import { ContentHarness, sampleContent, unwrap } from './content-helpers';
import type { ReadingSnapshot } from '../../src/lib/reading-sync';
import AxeBuilder from '@axe-core/playwright';

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || '');
    try { await use(content); } finally { await content.cleanup(); }
  },
});

test.describe('cross-device reading state and spaced review', () => {
  test.skip(!process.env.BLOG_TEST_SSH_TARGET && process.env.BLOG_TEST_LOCAL_AUTH !== '1', 'Requires the persistent private reading-state API.');

  test('syncs actions to the server, survives offline work and appears in another device', async ({ page, context, browser, baseURL, content }) => {
    let document = await content.create(sampleContent('跨设备阅读同步'));
    document = await content.action(document, 'publish');
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator('#live-title')).toHaveText(document.title);
    await expect.poll(() => page.evaluate(() => window.document.documentElement.scrollWidth - window.document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
    await expect.poll(async () => {
      const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
      return state.entries[document.id]?.bookmarked;
    }).toBe(true);

    await page.getByRole('button', { name: '加入回顾', exact: true }).click();
    await expect.poll(async () => {
      const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
      return state.entries[document.id]?.review?.step;
    }).toBe(0);
    await page.getByRole('button', { name: '完成本次回顾', exact: true }).click();
    await expect.poll(async () => {
      const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
      return state.entries[document.id]?.review?.step;
    }).toBe(1);

    await context.setOffline(true);
    await page.getByRole('button', { name: '标为已读', exact: true }).click();
    await expect(page.locator('#reading-sync-label')).toContainText('离线');
    await expect(page.getByRole('button', { name: '已读 · 撤销', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await context.setOffline(false);
    await expect.poll(async () => {
      const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
      return state.entries[document.id]?.read;
    }).toBe(true);

    const other = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      await establishSession(other, baseURL);
      const otherPage = await other.newPage();
      await otherPage.goto(`/articles/${document.id}/`);
      await expect(otherPage.getByRole('button', { name: `取消收藏：${document.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(otherPage.getByRole('button', { name: '停止回顾', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(otherPage.getByRole('button', { name: '已读 · 撤销', exact: true })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await other.close();
    }
  });

  test('shows an unavailable due document without inventing a public link', async ({ page }) => {
    const missing = 'f'.repeat(32);
    await page.route('**/api/reviews?limit=20', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { due: [{ key: missing, dueAt: new Date().toISOString(), step: 2 }], total: 1 } }),
    }));
    await page.goto('/');
    await expect(page.locator('.today-due-reviews')).toContainText('一篇到期文章当前不可打开');
    await expect(page.locator(`a[href*="${missing}"]`)).toHaveCount(0);
  });

  test('keeps the open footer status accessible in dark and light themes', async ({ page }) => {
    await page.goto('/');
    const status = page.locator('#reading-sync-status');
    await status.locator('summary').click();
    for (const theme of ['dark', 'light'] as const) {
      await page.locator('html').evaluate((root, selected) => { root.dataset.theme = selected; }, theme);
      const result = await new AxeBuilder({ page }).include('#reading-sync-status').analyze();
      expect(result.violations).toEqual([]);
    }
  });

  test('keeps a concurrent stale-tab intent after another tab has claimed the previous UUID', async ({ page, context, content }) => {
    let document = await content.create(sampleContent('已认领操作并发屏障'));
    document = await content.action(document, 'publish');
    const other = await context.newPage();
    await Promise.all([page.goto(`/articles/${document.id}/`), other.goto(`/articles/${document.id}/`)]);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let delayed = false;
    await page.route('**/api/reading-state', async route => {
      if (!delayed && route.request().method() === 'POST') {
        delayed = true;
        started();
        await gate;
      }
      await route.continue();
    });
    try {
      await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
      await requestStarted;
      await other.getByRole('button', { name: '标为已读', exact: true }).click();
      await expect.poll(() => other.evaluate(key => {
        const sync = JSON.parse(localStorage.getItem('asher-reading-sync-v1') || '{}');
        const operations = (sync.outbox || []).filter((item: { key: string }) => item.key === key).map((item: {
          opId: string; sent: boolean; patch: { bookmarked?: boolean; read?: boolean };
        }) => ({ opId: item.opId, sent: item.sent, patch: item.patch }));
        return {
          count: operations.length,
          ids: new Set(operations.map((item: { opId: string }) => item.opId)).size,
          sentBookmark: operations.some((item: { sent: boolean; patch: object }) => item.sent && 'bookmarked' in item.patch),
          unsentRead: operations.some((item: { sent: boolean; patch: object }) => !item.sent && 'read' in item.patch),
        };
      }, document.id)).toEqual({ count: 2, ids: 2, sentBookmark: true, unsentRead: true });
      release();
      await expect.poll(async () => {
        const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
        return { bookmarked: state.entries[document.id]?.bookmarked, read: state.entries[document.id]?.read };
      }).toEqual({ bookmarked: true, read: true });
    } finally {
      release();
      await page.unroute('**/api/reading-state');
      await other.close();
    }
  });

  test('warns when the private outbox cannot be durably stored and offers an export path', async ({ page, content }) => {
    let document = await content.create(sampleContent('队列容量警告'));
    document = await content.action(document, 'publish');
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('blocked', 'QuotaExceededError'); },
    }));
    await page.goto(`/articles/${document.id}/`);
    expect(await page.evaluate(() => {
      try { localStorage.setItem('sync-quota-probe', '1'); return 'writable'; }
      catch (error) { return error instanceof DOMException ? error.name : 'blocked'; }
    })).toBe('QuotaExceededError');
    await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
    await expect(page.locator('#reading-sync-detail')).toContainText('同步队列无法持久保存');
    await page.locator('#reading-sync-status summary').click();
    await expect(page.getByRole('link', { name: '前往书架导出备份', exact: true })).toHaveAttribute('href', '/library/');
  });

  test('falls back honestly to local-only state when Web Locks are unavailable', async ({ page, context, content }) => {
    let document = await content.create(sampleContent('无锁浏览器回退'));
    document = await content.action(document, 'publish');
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', {
      configurable: true,
      get: () => undefined,
    }));
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator('#reading-sync-detail')).toContainText('仅保存在本机');
    await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `取消收藏：${document.title}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
    expect(state.entries[document.id]).toBeUndefined();
  });

  test('keeps a durable outbox through a 401 and flushes it after reauthentication', async ({ page, context, baseURL, content }) => {
    let document = await content.create(sampleContent('登录过期保留队列'));
    document = await content.action(document, 'publish');
    await page.goto(`/articles/${document.id}/`);
    await context.setOffline(true);
    await page.getByRole('button', { name: `收藏：${document.title}`, exact: true }).click();
    await expect.poll(() => page.evaluate(key => {
      const sync = JSON.parse(localStorage.getItem('asher-reading-sync-v1') || '{}');
      return (sync.outbox || []).some((item: { key: string }) => item.key === key);
    }, document.id)).toBe(true);

    const origin = new URL(baseURL || '').origin;
    const logout = await context.request.post('/auth/logout', { headers: { Origin: origin } });
    expect(logout.ok()).toBe(true);
    await context.setOffline(false);
    await expect(page).toHaveURL(/\/login\/\?next=/);
    await submitRealLogin(page, baseURL);
    await expect(page).toHaveURL(new RegExp(`/articles/${document.id}/`));
    await expect.poll(async () => {
      const state = await unwrap<ReadingSnapshot>(await context.request.get('/api/reading-state'));
      return state.entries[document.id]?.bookmarked;
    }).toBe(true);
  });

  test('logout removes private sync metadata but preserves reading and theme preferences', async ({ page }) => {
    const key = `logout-preserve-${Date.now()}`;
    await page.addInitScript(key => {
      localStorage.setItem('asher-reading-v1', JSON.stringify({
        [key]: { bookmarked: true, read: false, progress: 0, updatedAt: 1 },
      }));
      localStorage.setItem('asher-theme', 'light');
    }, key);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('asher-reading-sync-v1', JSON.stringify({ private: 'queue' }));
    });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/login\/\?reason=logout/);
    await expect.poll(() => page.evaluate(storageKey => ({
      reading: JSON.parse(localStorage.getItem('asher-reading-v1') || '{}')[storageKey]?.bookmarked,
      sync: localStorage.getItem('asher-reading-sync-v1'),
      theme: localStorage.getItem('asher-theme'),
    }), key)).toEqual({
      reading: true,
      sync: null,
      theme: 'light',
    });
  });

  test('logout epoch prevents a queued edit in another tab from recreating private sync metadata', async ({ page, context, baseURL, content }) => {
    let document = await content.create(sampleContent('退出与跨标签写入屏障'));
    document = await content.action(document, 'publish');
    const other = await context.newPage();
    let logout: Promise<void> | undefined;
    let releaseLogoutRequest!: () => void;
    const logoutGate = new Promise<void>(resolve => { releaseLogoutRequest = resolve; });
    let logoutRequestSeen = false;
    // Exercise the client cleanup/mutation race before revoking the shared
    // session. Otherwise the other tab can correctly receive 401 and navigate
    // away before the intended queued mutation; that is a different race.
    await page.route('**/auth/logout', async route => {
      logoutRequestSeen = true;
      await logoutGate;
      await route.continue();
    });
    try {
      await Promise.all([page.goto(`/articles/${document.id}/`), other.goto(`/articles/${document.id}/`)]);
      for (const reader of [page, other]) {
        await expect(reader.locator('#live-title')).toHaveText(document.title);
        await expect(reader.locator('#article-body')).toBeVisible();
      }
      await page.evaluate(() => window.document.addEventListener('auth:clear', () => {
        (window as unknown as { authClearSeen: boolean }).authClearSeen = true;
      }, { once: true }));
      await other.evaluate(async () => {
        (window as unknown as { dataLockHeld: boolean; releaseDataLock?: () => void }).dataLockHeld = false;
        void navigator.locks.request('asher-reading-sync-data', () => new Promise<void>(resolve => {
          const state = window as unknown as { dataLockHeld: boolean; releaseDataLock?: () => void };
          state.dataLockHeld = true;
          state.releaseDataLock = resolve;
        }));
      });
      await expect.poll(() => other.evaluate(() => (window as unknown as { dataLockHeld: boolean }).dataLockHeld)).toBe(true);

      const response = page.waitForResponse(value => value.url().endsWith('/auth/logout'));
      logout = page.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { authClearSeen?: boolean }).authClearSeen))).toBe(true);
      await expect.poll(() => logoutRequestSeen).toBe(true);
      await other.getByRole('button', { name: '标为已读', exact: true }).click();
      await expect.poll(() => other.evaluate(documentId => Object.keys(localStorage)
        .filter(key => key.startsWith('asher-reading-sync-journal-'))
        .some(key => {
          const journal = JSON.parse(localStorage.getItem(key) || '{}');
          return journal.key === documentId && journal.patch?.read === true;
        }), document.id)).toBe(true);
      await other.evaluate(() => (window as unknown as { releaseDataLock?: () => void }).releaseDataLock?.());
      releaseLogoutRequest();
      expect((await response).status()).toBe(200);
      await logout;
      await expect(page).toHaveURL(/\/login\/\?reason=logout$/);
      await expect.poll(() => page.evaluate(() => ({
        epoch: Boolean(localStorage.getItem('asher-reading-sync-logout-epoch')),
        sync: localStorage.getItem('asher-reading-sync-v1'),
        journals: Object.keys(localStorage).filter(key => key.startsWith('asher-reading-sync-journal-')).length,
      }))).toEqual({ epoch: true, sync: null, journals: 0 });
    } finally {
      releaseLogoutRequest();
      await other.evaluate(() => (window as unknown as { releaseDataLock?: () => void }).releaseDataLock?.()).catch(() => {});
      await other.close().catch(() => {});
      await logout?.catch(() => {});
      await establishSession(context, baseURL);
    }
  });
});
