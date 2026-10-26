import { describe, expect, it } from "vitest";
import {
  canonicalShellPath,
  extractCompiledReferences,
  extractOfflineShellAssets,
  forbiddenNetworkPath,
  renderServiceWorker,
} from "../../src/build/pwa-integration.mjs";
import { controllerChangeAction, reloadGuardPassed } from "../../src/lib/pwa-update";

describe("PWA shell policy", () => {
  it("does not reload for a failed editor flush or an unsolicited controller claim", () => {
    expect(reloadGuardPassed([undefined, true])).toBe(true);
    expect(reloadGuardPassed([undefined, false])).toBe(false);
    expect(controllerChangeAction(false)).toBe("offer");
    expect(controllerChangeAction(true)).toBe("reload");
  });
  it("extracts only same-origin compiled files from the standalone offline page", () => {
    const html = `<!doctype html><link rel="stylesheet" href="/_astro/offline.abc.css"><script type="module" src="/_astro/offline.def.js"></script><img src="/api/assets/private.png"><script src="https://cdn.example/x.js"></script>`;
    expect(extractOfflineShellAssets(html)).toEqual([
      "/_astro/offline.abc.css",
      "/_astro/offline.def.js",
    ]);
  });

  it("finds only relative compiled dependencies from an offline JS or CSS chunk", () => {
    const js = `import "./vault.ABC.js"; export { x } from "./model.XYZ.js"; import("./lazy.123.js"); fetch("/api/private"); import("../escape.js")`;
    expect(extractCompiledReferences(js, "/_astro/offline.entry.js")).toEqual([
      "/_astro/lazy.123.js",
      "/_astro/model.XYZ.js",
      "/_astro/vault.ABC.js",
    ]);
    const css = `@import "./tokens.abc.css"; .hero{background:url('./safe.hash.svg')} .x{background:url('/api/assets/private.png')}`;
    expect(extractCompiledReferences(css, "/_astro/offline.css")).toEqual([
      "/_astro/safe.hash.svg",
      "/_astro/tokens.abc.css",
    ]);
  });

  it("rejects aliases, query strings and every private route", () => {
    const allow = new Set(["/offline/", "/manifest.webmanifest", "/icons/app.svg"]);
    expect(canonicalShellPath("https://knowledge.test/offline/", "https://knowledge.test", allow)).toBe("/offline/");
    for (const path of ["/offline/?id=private", "/api/documents/1", "/auth/logout", "/login/", "/articles/private/"]) {
      expect(canonicalShellPath(`https://knowledge.test${path}`, "https://knowledge.test", allow)).toBeNull();
    }
    expect(canonicalShellPath("https://evil.test/offline/", "https://knowledge.test", allow)).toBeNull();
  });

  it("explicitly bypasses authentication, API and login navigations", () => {
    for (const path of ["/api", "/api/documents/1", "/auth", "/auth/logout", "/login", "/login/"]) {
      expect(forbiddenNetworkPath(path)).toBe(true);
    }
    for (const path of ["/", "/offline/", "/articles/abc/", "/apiary/"]) expect(forbiddenNetworkPath(path)).toBe(false);
  });

  it("renders a build-versioned worker with an exact allowlist and network-only private routes", () => {
    const worker = renderServiceWorker("build-123", ["/offline/", "/_astro/offline.js"]);
    expect(worker).toContain('const CACHE_NAME = "asher-offline-shell-build-123"');
    expect(worker).toContain('"/_astro/offline.js"');
    expect(worker).toContain("event.respondWith(navigation(request))");
    expect(worker).toContain('url.pathname === "/api"');
    expect(worker).toContain('url.pathname.startsWith("/auth/")');
    expect(worker).toContain('url.pathname.startsWith("/login/")');
    expect(worker).toContain('redirect: "error"');
    expect(worker).toContain('response.type !== "basic"');
    expect(worker).toContain("finalURL.pathname !== path");
    expect(worker).not.toContain("cache.addAll");
  });
});
