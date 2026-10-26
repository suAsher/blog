import type { DocumentDetail } from "./documents";
import {
  MAX_BUNDLE_BYTES,
  MAX_IMAGES,
  SNAPSHOT_TTL_MS,
  validateSnapshot,
  type OfflineAsset,
  type OfflineSnapshot,
} from "./offline-vault-model";

const DOCUMENT_PATH = /^\/articles\/([a-f0-9]{32})\/$/;
const ASSET_PATH = /^\/api\/assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/;
const MIME_BY_EXTENSION: Record<string, OfflineAsset["mime"]> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

export function offlineDocumentId(pathname: string): string | null {
  return DOCUMENT_PATH.exec(pathname)?.[1] || null;
}

export function safeSnapshotAssetPath(value: string, origin = location.origin): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.search || url.hash || !ASSET_PATH.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

export function isCanonicalAssetResponse(
  response: Pick<Response, "ok" | "type" | "url">,
  requestedPath: string,
  origin: string,
): boolean {
  if (!response.ok || response.type !== "basic") return false;
  try {
    const finalURL = new URL(response.url);
    return finalURL.origin === origin && finalURL.pathname === requestedPath && !finalURL.search && !finalURL.hash;
  } catch { return false; }
}

export type ValidationDecision = "keep" | "purge-record" | "purge-all" | "defer";
export function classifyValidationResponse(status: number, remoteVersion?: number, storedVersion?: number): ValidationDecision {
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return "purge-all";
  if (status === 404 || status === 410) return "purge-record";
  if (status === 200) return remoteVersion === storedVersion ? "keep" : "purge-record";
  return "defer";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function readBoundedImage(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error("单篇离线资料最多占用 16 MiB。");
  if (!response.body) throw new Error("浏览器无法安全读取这张配图。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error("单篇离线资料最多占用 16 MiB。");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function collectAssetPaths(document: DocumentDetail, origin: string): string[] {
  const template = window.document.createElement("template");
  template.innerHTML = document.html;
  const candidates = [document.cover, ...[...template.content.querySelectorAll<HTMLImageElement>("img")].map(image => image.getAttribute("src") || "")];
  return [...new Set(candidates.map(value => safeSnapshotAssetPath(value, origin)).filter((value): value is string => Boolean(value)))];
}

export async function projectPublishedSnapshot(
  document: DocumentDetail,
  options: { origin?: string; now?: number; signal?: AbortSignal } = {},
): Promise<OfflineSnapshot> {
  const origin = options.origin || location.origin;
  const now = options.now ?? Date.now();
  if (document.status !== "published") throw new Error("只有已发布文档可以保存为离线资料。");
  const paths = collectAssetPaths(document, origin);
  if (paths.length > MAX_IMAGES) throw new Error(`每篇离线资料最多保存 ${MAX_IMAGES} 张配图。`);
  const assets: Record<string, OfflineAsset> = {};
  let approximateBytes = new TextEncoder().encode(document.html).byteLength;
  for (const path of paths) {
    const response = await fetch(path, { credentials: "same-origin", signal: options.signal, cache: "no-store", redirect: "error" });
    if (!isCanonicalAssetResponse(response, path, origin)) throw new Error("配图响应地址不可信，已停止保存。");
    const extension = path.slice(path.lastIndexOf(".") + 1);
    const expected = MIME_BY_EXTENSION[extension];
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!expected || mime !== expected) throw new Error("配图格式与服务器声明不一致，已停止保存。");
    const bytes = await readBoundedImage(response, MAX_BUNDLE_BYTES - approximateBytes);
    approximateBytes += bytes.byteLength;
    if (approximateBytes > MAX_BUNDLE_BYTES) throw new Error("单篇离线资料最多占用 16 MiB。");
    assets[path] = { mime: expected, base64: bytesToBase64(bytes) };
  }
  return validateSnapshot({
    schema: 1,
    id: document.id,
    version: document.version,
    title: document.title,
    description: document.description,
    date: document.date,
    category: document.category,
    tags: [...document.tags],
    readingMinutes: document.readingMinutes,
    savedAt: now,
    expiresAt: now + SNAPSHOT_TTL_MS,
    html: document.html,
    headings: document.headings.map(heading => ({ ...heading })),
    ...(safeSnapshotAssetPath(document.cover, origin) ? { cover: safeSnapshotAssetPath(document.cover, origin)! } : {}),
    assets,
  }, now);
}

const OFFLINE_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6",
  "HR", "IMG", "INPUT", "LI", "OL", "P", "PRE", "S", "SPAN", "STRONG", "TABLE", "TBODY",
  "TD", "TH", "THEAD", "TR", "UL",
]);

function allowedAttributes(element: Element): Set<string> {
  switch (element.tagName) {
    case "A": return new Set(["href", "title", "class", "data-wiki-target"]);
    case "IMG": return new Set(["src", "alt", "title"]);
    case "INPUT": return new Set(["type", "checked", "disabled"]);
    case "CODE": return new Set(["class"]);
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return new Set(["id"]);
    case "OL": return new Set(["start"]);
    case "TD": case "TH": return new Set(["align"]);
    case "SPAN": return new Set(["class", "data-wiki-target", "title", "aria-hidden"]);
    default: return new Set();
  }
}

function sanitizeClass(element: Element): void {
  const value = element.getAttribute("class") || "";
  if (element.tagName === "CODE" && /^language-[a-z0-9_+-]{1,40}$/i.test(value)) return;
  if ((element.tagName === "A" || element.tagName === "SPAN") && /^(?:wiki-link)(?: wiki-link--(?:missing|ambiguous|unavailable))?$/.test(value)) return;
  element.removeAttribute("class");
}

function structurallySanitize(fragment: DocumentFragment): void {
  for (const comment of [...fragment.childNodes].flatMap(function descendants(node): Comment[] {
    return [...node.childNodes].flatMap(descendants).concat(node.nodeType === Node.COMMENT_NODE ? [node as Comment] : []);
  })) comment.remove();
  for (const element of [...fragment.querySelectorAll("*")]) {
    if (!OFFLINE_TAGS.has(element.tagName)) {
      element.replaceWith(document.createTextNode(element.textContent || ""));
      continue;
    }
    const allowed = allowedAttributes(element);
    for (const attribute of [...element.attributes]) if (!allowed.has(attribute.name)) element.removeAttribute(attribute.name);
    if (element.hasAttribute("class")) sanitizeClass(element);
    if (element.tagName === "INPUT") {
      if (element.getAttribute("type") !== "checkbox") { element.replaceWith(document.createTextNode("")); continue; }
      element.setAttribute("disabled", "");
    }
    if ((element.tagName === "TD" || element.tagName === "TH") && !/^(?:left|right|center)$/.test(element.getAttribute("align") || "")) element.removeAttribute("align");
    if (element.tagName === "OL" && !/^[1-9]\d{0,5}$/.test(element.getAttribute("start") || "")) element.removeAttribute("start");
  }
}

export function prepareSnapshotFragment(snapshot: OfflineSnapshot, owner: Document = document): DocumentFragment {
  const validated = validateSnapshot(snapshot);
  const template = owner.createElement("template");
  template.innerHTML = validated.html;
  structurallySanitize(template.content);
  template.content.querySelectorAll<HTMLElement>("[srcset]").forEach(element => element.removeAttribute("srcset"));
  template.content.querySelectorAll<HTMLElement>("[src]").forEach(element => {
    if (element.tagName !== "IMG") {
      element.removeAttribute("src");
      return;
    }
    const image = element as HTMLImageElement;
    const path = safeSnapshotAssetPath(image.getAttribute("src") || "", location.origin);
    const asset = path ? validated.assets[path] : undefined;
    if (asset) image.src = `data:${asset.mime};base64,${asset.base64}`;
    else {
      image.removeAttribute("src");
      image.dataset.offlineImageMissing = "";
    }
    image.loading = "lazy";
    image.decoding = "async";
  });
  template.content.querySelectorAll<HTMLAnchorElement>("a[href]").forEach(link => {
    const value = link.getAttribute("href") || "";
    if (value.startsWith("#")) return;
    try {
      const url = new URL(value, location.origin);
      const id = url.origin === location.origin ? offlineDocumentId(url.pathname) : null;
      if (id) {
        link.href = `/offline/?id=${encodeURIComponent(id)}`;
        link.dataset.offlineDocument = id;
      } else if (url.protocol !== "http:" && url.protocol !== "https:") {
        link.removeAttribute("href");
      }
    } catch { link.removeAttribute("href"); }
  });
  return template.content;
}
