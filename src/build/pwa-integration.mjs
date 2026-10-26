import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const COMPILED_ASSET = /^\/_astro\/[A-Za-z0-9._-]+\.(?:css|js|svg|png|jpe?g|webp|gif|woff2?)$/;
const REQUIRED_PUBLIC = [
  "/offline/",
  "/manifest.webmanifest",
  "/icons/app-icon.svg",
  "/icons/app-icon-maskable.svg",
];
const DEFAULT_TEMPLATE = await readFile(new URL("../../public/sw-template.txt", import.meta.url), "utf8");

export function extractOfflineShellAssets(html) {
  const found = new Set();
  for (const match of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], "https://offline.invalid");
      if (url.origin === "https://offline.invalid" && !url.search && !url.hash && COMPILED_ASSET.test(url.pathname)) found.add(url.pathname);
    } catch { /* Ignore malformed markup emitted by neither Astro nor this page. */ }
  }
  return [...found].sort();
}

export function extractCompiledReferences(source, parentPath) {
  if (!COMPILED_ASSET.test(parentPath)) return [];
  const references = new Set();
  const values = [];
  if (parentPath.endsWith(".js")) {
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)) values.push(match[1]);
  } else if (parentPath.endsWith(".css")) {
    for (const match of source.matchAll(/(?:@import\s+|url\(\s*)["']?([^"')\s]+)["']?\s*\)?/g)) values.push(match[1]);
  }
  for (const value of values) {
    if (!value.startsWith("./")) continue;
    const resolved = new URL(value, `https://offline.invalid${parentPath}`);
    if (resolved.origin === "https://offline.invalid" && !resolved.search && !resolved.hash && COMPILED_ASSET.test(resolved.pathname)) references.add(resolved.pathname);
  }
  return [...references].sort();
}

export async function collectOfflineDependencies(dir, initial) {
  const found = new Set(initial);
  const queue = [...initial];
  while (queue.length) {
    const path = queue.shift();
    if (!path.endsWith(".js") && !path.endsWith(".css")) continue;
    const source = await readFile(new URL(path.slice(1), dir), "utf8");
    for (const dependency of extractCompiledReferences(source, path)) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      queue.push(dependency);
    }
  }
  return [...found].sort();
}

export function canonicalShellPath(raw, origin, allowlist) {
  try {
    const url = new URL(raw);
    return url.origin === origin && !url.search && !url.hash && allowlist.has(url.pathname) ? url.pathname : null;
  } catch {
    return null;
  }
}

export function forbiddenNetworkPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/") ||
    pathname === "/auth" || pathname.startsWith("/auth/") ||
    pathname === "/login" || pathname.startsWith("/login/");
}

export function renderServiceWorker(version, paths, template = DEFAULT_TEMPLATE) {
  const safeVersion = version.replace(/[^a-z0-9-]/gi, "");
  const safePaths = [...new Set(paths)].filter(path => path.startsWith("/") && !/[?#]/.test(path));
  if ((template.match(/__CACHE_NAME__/g) || []).length !== 1 || (template.match(/__SHELL__/g) || []).length !== 1) {
    throw new Error("Service-worker template placeholders are invalid.");
  }
  return template
    .replace("__CACHE_NAME__", JSON.stringify(`asher-offline-shell-${safeVersion}`))
    .replace("__SHELL__", JSON.stringify(safePaths));
}

export function privatePWA() {
  return {
    name: "private-offline-pwa",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const offlineURL = new URL("offline/index.html", dir);
        const html = await readFile(offlineURL, "utf8");
        const dependencies = await collectOfflineDependencies(dir, extractOfflineShellAssets(html));
        const paths = [...REQUIRED_PUBLIC, ...dependencies];
        const hash = createHash("sha256");
        for (const path of paths) {
          const file = path === "/offline/" ? offlineURL : new URL(path.slice(1), dir);
          hash.update(path).update(await readFile(file));
        }
        hash.update(DEFAULT_TEMPLATE);
        const version = hash.digest("hex").slice(0, 16);
        await writeFile(new URL("sw.js", dir), renderServiceWorker(version, paths));
      },
    },
  };
}
