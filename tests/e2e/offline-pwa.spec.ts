import { expect } from "@playwright/test";
import { test as authenticatedTest } from "./fixtures";
import { ContentHarness, sampleContent, tinyPNG } from "./content-helpers";
import { establishSession } from "./fixtures";

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try { await use(content); } finally { await content.cleanup(); }
  },
});

test.describe("encrypted private offline PWA", () => {
  test.skip(process.env.BLOG_TEST_LOCAL_AUTH !== "1", "Requires the real local HTTPS auth/API harness.");

  test("storage and BroadcastChannel denial do not break core navigation", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: class { constructor() { throw new DOMException("blocked", "SecurityError"); } } });
      const denied = () => { throw new DOMException("blocked", "SecurityError"); };
      Object.defineProperty(window.indexedDB, "open", { configurable: true, value: denied });
    });
    await page.goto("/");
    await expect(page.locator("[data-open-search]")).toBeVisible();
    await expect(page.locator("[data-theme-toggle]")).toBeVisible();
    await expect(page.locator("#device-tools .device-warning")).toContainText("无法使用离线资料");
  });

  test("serializes concurrent first-time vault creation across tabs", async ({ page, context }) => {
    await page.goto("/offline/");
    const peer = await context.newPage();
    await peer.goto("/offline/");
    for (const target of [page, peer]) {
      await target.getByLabel("此设备的离线口令", { exact: true }).fill("simultaneous local passphrase");
      await target.getByLabel("再次输入离线口令", { exact: true }).fill("simultaneous local passphrase");
      await target.getByRole("checkbox").check();
    }
    await Promise.all([
      page.getByRole("button", { name: "建立此设备的离线资料库", exact: true }).click(),
      peer.getByRole("button", { name: "建立此设备的离线资料库", exact: true }).click(),
    ]);
    await expect(page.locator("#offline-library")).toBeVisible();
    await expect(peer.locator("#offline-library")).toBeVisible();

    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("asher-private-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const salt = await new Promise<string>((resolve, reject) => {
        const request = db.transaction("meta").objectStore("meta").get("salt");
        request.onsuccess = () => resolve(request.result.value);
        request.onerror = () => reject(request.error);
      });
      const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
      const material = await crypto.subtle.importKey("raw", new TextEncoder().encode("simultaneous local passphrase"), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: decode(salt), iterations: 310_000 }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      const now = Date.now();
      const expiresAt = now + 5_000;
      const savedAt = expiresAt - 7 * 24 * 60 * 60 * 1000;
      const value = {
        schema: 1, id: "f".repeat(32), version: 1, title: "结构净化测试", description: "", date: "2026-10-26",
        category: "QA", tags: [], readingMinutes: 1, savedAt, expiresAt,
        html: `<table background="/api/private"><tbody><tr><td>安全正文</td></tr></tbody></table><a id="safe" href="#safe" ping="/auth/logout">测试链接</a><img src="/api/private">`,
        headings: [], assets: {},
      };
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value))));
      const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      const transaction = db.transaction("bundles", "readwrite");
      transaction.objectStore("bundles").put({ id: value.id, version: 1, savedAt, expiresAt, bytes: iv.byteLength + cipher.byteLength, iv: encode(iv), ciphertext: encode(cipher) });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });
    const leaked: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/private" || path === "/auth/logout") leaked.push(path);
    });
    await page.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(peer.locator("#offline-locked")).toBeVisible();
    await page.getByLabel("此设备的离线口令", { exact: true }).fill("simultaneous local passphrase");
    await page.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await page.getByRole("link", { name: /结构净化测试/ }).click();
    await expect(page.locator("#offline-body")).toContainText("安全正文");
    await expect(page.locator("#offline-body table")).not.toHaveAttribute("background");
    await expect(page.locator("#offline-body a")).not.toHaveAttribute("ping");
    await expect(page.locator("#offline-body img")).not.toHaveAttribute("src");
    await page.locator("#offline-body a").click();
    expect(leaked).toEqual([]);
    await expect(page.locator("#offline-locked")).toBeVisible({ timeout: 8_000 });
    await expect(peer.locator("#offline-locked")).toBeVisible();
    await expect(page.locator("#offline-body")).toBeEmpty();
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("asher-private-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise<number>((resolve, reject) => {
        const request = db.transaction("bundles").objectStore("bundles").count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return count;
    })).toBe(0);
    await peer.close();
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "清除此设备资料", exact: true }).click();
    await expect(page.locator("#vault-count")).toContainText("还没有离线资料");
  });

  test("rejects partial vault metadata instead of replacing its encryption key", async ({ page }) => {
    await page.goto("/offline/");
    await expect(page.locator("#vault-count")).toContainText("还没有离线资料");
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("asher-private-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction("meta", "readwrite");
      transaction.objectStore("meta").put({ key: "salt", value: "AAAAAAAAAAAAAAAAAAAAAA==" });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    });
    await page.reload();
    await expect(page.locator("#unlock-error")).toContainText("离线资料库不完整");
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "清除此设备资料", exact: true }).click();
  });

  test("rejects persisted records beyond the vault budget before validation or decryption", async ({ page }) => {
    await page.goto("/offline/");
    await expect(page.locator("#vault-count")).toContainText("还没有离线资料");
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("asher-private-offline-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(["meta", "bundles"], "readwrite");
      tx.objectStore("meta").put({ key: "salt", value: "AAAAAAAAAAAAAAAAAAAAAA==" });
      tx.objectStore("meta").put({ key: "verifier", value: JSON.stringify({ iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=" }) });
      for (let index = 0; index < 21; index++) tx.objectStore("bundles").put({
        id: index.toString(16).padStart(32, "0"), version: 1, savedAt: 1_000,
        expiresAt: 1_000 + 7 * 24 * 60 * 60 * 1000, bytes: 29,
        iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    let validations = 0;
    await page.route("**/api/offline-revisions?**", route => { validations++; return route.continue(); });
    await page.reload();
    await expect(page.locator("#unlock-error")).toContainText("超过安全上限");
    expect(validations).toBe(0);
    page.on("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "清除此设备资料", exact: true }).click();
  });

  test("validates stored revisions before the initial online unlock view", async ({ page, content }) => {
    let document = await content.create(sampleContent("初始撤回验证", "## 初始撤回\n\n这份副本必须在解锁前失效。"));
    document = await content.action(document, "publish");
    await page.goto(`/articles/${document.id}/`);
    await page.getByRole("button", { name: "保存离线", exact: true }).click();
    const dialog = page.locator("#offline-save-dialog");
    await dialog.getByLabel("离线口令", { exact: true }).fill("initial validation passphrase");
    await dialog.getByLabel("再次输入离线口令", { exact: true }).fill("initial validation passphrase");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存离线", exact: true })).toBeVisible();
    document = await content.action(document, "unpublish");

    const validation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/offline-revisions");
    await page.goto("/offline/");
    expect((await validation).status()).toBe(200);
    await expect(page.locator("#vault-count")).toContainText("0 个加密资料包");
    await expect(page.locator("#unlock-submit")).toBeEnabled();
  });

  test("rejects redirected assets, retries the real save, and waits for the offline shell", async ({ page, context, content }) => {
    const asset = `/api/assets/${"a".repeat(64)}.png`;
    let document = await content.create(sampleContent("配图安全重试", `## 配图\n\n![像素](${asset})`));
    document = await content.action(document, "publish");
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator("#live-title")).toHaveText(document.title);

    let redirected = false;
    await page.route(`**${asset}`, async route => {
      if (!redirected && route.request().resourceType() === "fetch") {
        redirected = true;
        await route.fulfill({ status: 302, headers: { location: "/login/" }, body: "not an image" });
      } else await route.fulfill({ status: 200, contentType: "image/png", body: tinyPNG });
    });
    await page.getByRole("button", { name: "保存离线", exact: true }).click();
    const dialog = page.locator("#offline-save-dialog");
    await dialog.getByLabel("离线口令", { exact: true }).fill("asset retry passphrase");
    await dialog.getByLabel("再次输入离线口令", { exact: true }).fill("asset retry passphrase");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(/配图|fetch|网络/);

    await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存离线", exact: true })).toBeVisible({ timeout: 12_000 });
    expect(redirected).toBe(true);

    // Success is not reported until the worker's exact offline shell has
    // activated, so an immediate disconnect must still reach the unlock page.
    await context.setOffline(true);
    await page.goto("/offline/");
    await expect(page.locator("#offline-title")).toHaveText("离线，也只由你打开。");
    await context.setOffline(false);
  });

  test("explicitly saves a published projection and reads it offline after unlocking", async ({ page, context, content }) => {
    let document = await content.create(sampleContent("加密离线阅读", "## 离线正文\n\n只有明确保存后才应出现在设备资料库。\n\n```go\nfmt.Println(\"offline\")\n```"));
    document = await content.action(document, "publish");
    const title = document.title;

    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator("#live-title")).toHaveText(title);
    await page.getByRole("button", { name: "保存离线", exact: true }).click();
    const dialog = page.locator("#offline-save-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("离线口令", { exact: true }).fill("local-only passphrase 2026");
    await dialog.getByLabel("再次输入离线口令", { exact: true }).fill("local-only passphrase 2026");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存离线", exact: true })).toBeVisible();

    const shellResponses = await page.evaluate(async () => {
      const worker = await fetch("/sw.js", { cache: "no-store" }).then(response => response.text());
      const shell = JSON.parse(/const SHELL = Object\.freeze\((\[[^;]+\])\)/.exec(worker)?.[1] || "[]") as string[];
      return Promise.all(shell.map(async path => {
        try {
          const response = await fetch(path, { credentials: "same-origin", cache: "reload", redirect: "error" });
          return { path, status: response.status, type: response.type, final: new URL(response.url).pathname };
        } catch (error) { return { path, error: String(error) }; }
      }));
    });
    expect(shellResponses).toEqual(shellResponses.map(response => ({ ...response, status: 200, type: "basic", final: response.path })));
    await expect.poll(async () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration ? `active:${registration.active?.state || "none"}|waiting:${registration.waiting?.state || "none"}|installing:${registration.installing?.state || "none"}` : "missing";
    }), { timeout: 15_000 }).toContain("active:activated");
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    await page.goto("/offline/");
    await expect(page.locator("#vault-count")).toContainText("1 个加密资料包");
    await page.getByLabel("此设备的离线口令", { exact: true }).fill("local-only passphrase 2026");
    await page.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible();

    await context.setOffline(true);
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page.locator("#offline-document-title")).toHaveText(title);
    await expect(page.locator("#offline-body")).toContainText("只有明确保存后");
    await expect(page.getByRole("button", { name: "复制代码", exact: true })).toBeVisible();
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator("#offline-title")).toHaveText("离线，也只由你打开。");
    await page.getByLabel("此设备的离线口令", { exact: true }).fill("local-only passphrase 2026");
    await page.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await expect(page.locator("#offline-document-title")).toHaveText(title);
    await page.reload();
    await expect(page.locator("#offline-title")).toHaveText("离线，也只由你打开。");
    await context.setOffline(false);

    const cacheURLs = await page.evaluate(async () => {
      const names = await caches.keys();
      const requests = (await Promise.all(names.map(name => caches.open(name).then(cache => cache.keys())))).flat();
      return requests.map(request => new URL(request.url).pathname);
    });
    expect(cacheURLs).not.toContain(`/articles/${document.id}/`);
    expect(cacheURLs.some(path => path.startsWith("/api/") || path.startsWith("/auth/") || path === "/login/" || path === "/search-index.json")).toBe(false);
    const generatedAllowlist = await page.evaluate(async () => {
      const worker = await fetch("/sw.js", { cache: "no-store" }).then(response => response.text());
      return JSON.parse(/const SHELL = Object\.freeze\((\[[^;]+\])\)/.exec(worker)?.[1] || "[]") as string[];
    });
    expect([...new Set(cacheURLs)].sort()).toEqual([...generatedAllowlist].sort());

    let loginFailed = false;
    page.on("requestfailed", request => { if (new URL(request.url()).pathname === "/login/") loginFailed = true; });
    await context.setOffline(true);
    await page.evaluate(() => {
      const frame = window.document.createElement("iframe");
      frame.hidden = true;
      frame.src = "/login/";
      window.document.body.append(frame);
    });
    await expect.poll(() => loginFailed).toBe(true);
    await context.setOffline(false);

    await page.getByLabel("此设备的离线口令", { exact: true }).fill("local-only passphrase 2026");
    await page.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await expect(page.locator("#offline-body")).toContainText("只有明确保存后");
    const peer = await context.newPage();
    await peer.goto("/offline/");
    await peer.getByLabel("此设备的离线口令", { exact: true }).fill("local-only passphrase 2026");
    await peer.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await peer.getByRole("link", { name: new RegExp(title) }).click();
    await expect(peer.locator("#offline-body")).toContainText("只有明确保存后");

    document = await content.action(document, "unpublish");
    const validation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/offline-revisions");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const validationResponse = await validation;
    expect(validationResponse.status()).toBe(200);
    await expect(page.locator("#offline-locked")).toBeVisible();
    await expect(peer.locator("#offline-locked")).toBeVisible();
    await expect(page.locator("#offline-body")).toBeEmpty();
    await expect(peer.locator("#offline-body")).toBeEmpty();
    await expect(page.locator("#vault-count")).toContainText("0 个加密资料包");
    await peer.close();
  });

  test("logout locks another tab immediately, purges the vault, and online 401 never falls back", async ({ page, context, content, baseURL }) => {
    let document = await content.create(sampleContent("跨标签离线", "## 私人离线正文\n\n退出时必须立即消失。"));
    document = await content.action(document, "publish");
    await page.goto(`/articles/${document.id}/`);
    await page.getByRole("button", { name: "保存离线", exact: true }).click();
    const dialog = page.locator("#offline-save-dialog");
    await dialog.getByLabel("离线口令", { exact: true }).fill("another local passphrase");
    await dialog.getByLabel("再次输入离线口令", { exact: true }).fill("another local passphrase");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(page.getByRole("button", { name: "已保存离线", exact: true })).toBeVisible();

    const offline = await context.newPage();
    await offline.goto("/offline/");
    await offline.getByLabel("此设备的离线口令", { exact: true }).fill("another local passphrase");
    await offline.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await expect(offline.getByRole("link", { name: new RegExp(document.title) })).toBeVisible();

    const peer = await context.newPage();
    await peer.goto("/offline/");
    await peer.getByLabel("此设备的离线口令", { exact: true }).fill("another local passphrase");
    await peer.getByRole("button", { name: "解锁离线资料", exact: true }).click();
    await expect(peer.getByRole("link", { name: new RegExp(document.title) })).toBeVisible();
    await offline.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(peer.locator("#offline-locked")).toBeVisible();
    await peer.getByLabel("此设备的离线口令", { exact: true }).fill("another local passphrase");
    await peer.getByRole("button", { name: "解锁离线资料", exact: true }).click();

    await page.goto("/");
    await page.locator("[data-logout]").click();
    await expect(page).toHaveURL(/\/login\/\?reason=logout/);
    await expect(peer.locator("#offline-locked")).toBeVisible();
    await expect(offline.locator("#offline-list")).toBeEmpty();
    await expect.poll(() => offline.evaluate(async () => {
      const request = indexedDB.open("asher-private-offline-v1");
      return await new Promise(resolve => {
        request.onsuccess = () => {
          const db = request.result;
          const exists = db.objectStoreNames.contains("bundles");
          db.close();
          resolve(exists);
        };
        request.onerror = () => resolve(false);
      });
    })).toBe(false);

    const response = await offline.evaluate(async id => {
      const result = await fetch(`/api/documents/${id}?view=published`, { credentials: "same-origin" });
      return { status: result.status, body: await result.text() };
    }, document.id);
    expect(response.status).toBe(401);
    expect(response.body).not.toContain("离线，也只由你打开");
    await establishSession(context, baseURL);
  });
});
