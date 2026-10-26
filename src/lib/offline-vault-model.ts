export const MAX_DOCUMENTS = 20;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGES = 32;
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ID = /^[a-f0-9]{32}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_ASSET = /^\/api\/assets\/[a-f0-9]{64}\.(?:png|jpe?g|webp|gif)$/;
const SAFE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface OfflineAsset {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
}

export interface OfflineSnapshot {
  schema: 1;
  id: string;
  version: number;
  title: string;
  description: string;
  date: string;
  category: string;
  tags: string[];
  readingMinutes: number;
  savedAt: number;
  expiresAt: number;
  html: string;
  headings: { depth: number; slug: string; text: string }[];
  cover?: string;
  assets: Record<string, OfflineAsset>;
}

export interface VaultRecordInfo {
  id: string;
  bytes: number;
}

export function withinPersistedVaultBudget(documentCount: number, encryptedBytes: number): boolean {
  return Number.isSafeInteger(documentCount) && documentCount >= 0 && documentCount <= MAX_DOCUMENTS &&
    Number.isSafeInteger(encryptedBytes) && encryptedBytes >= 0 && encryptedBytes <= MAX_TOTAL_BYTES;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, limit: number, allowEmpty = true): value is string {
  return typeof value === "string" && value.length <= limit && (allowEmpty || value.trim().length > 0);
}

function validBase64(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BUNDLE_BYTES * 2 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function unsafeHTML(html: string): boolean {
  return /<(?:script|style|svg|math|iframe|object|embed|form|button|textarea|select|meta|base|link|video|audio|source|picture)\b/i.test(html) ||
    /\s(?:on[a-z]+|style|srcdoc)\s*=/i.test(html) || /(?:javascript|data\s*:\s*text\/html)\s*:/i.test(html);
}

export function validateSnapshot(value: unknown, now = Date.now()): OfflineSnapshot {
  if (!record(value) || value.schema !== 1 || !ID.test(String(value.id)) ||
      !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      !text(value.title, 300, false) || !text(value.description, 2_000) ||
      !text(value.category, 120) || typeof value.date !== "string" || !DATE.test(value.date) ||
      !Number.isSafeInteger(value.readingMinutes) || Number(value.readingMinutes) < 0 || Number(value.readingMinutes) > 100_000 ||
      !Number.isSafeInteger(value.savedAt) || !Number.isSafeInteger(value.expiresAt) ||
      Number(value.expiresAt) - Number(value.savedAt) !== SNAPSHOT_TTL_MS ||
      !text(value.html, MAX_BUNDLE_BYTES, false) || !record(value.assets)) {
    throw new Error("离线资料格式无效，已拒绝打开。");
  }
  if (Number(value.expiresAt) <= now) throw new Error("离线资料已过期，请联网后重新保存。");
  if (unsafeHTML(value.html)) throw new Error("离线资料包含不安全内容，已拒绝打开。");
  if (!Array.isArray(value.tags) || value.tags.length > 64 || !value.tags.every(item => text(item, 120, false)) ||
      !Array.isArray(value.headings) || value.headings.length > 500) {
    throw new Error("离线资料格式无效，已拒绝打开。");
  }
  const headings = value.headings.map(item => {
    if (!record(item) || ![2, 3].includes(Number(item.depth)) || !text(item.slug, 300, false) || !text(item.text, 500, false)) {
      throw new Error("离线资料目录格式无效。");
    }
    return { depth: Number(item.depth), slug: item.slug, text: item.text };
  });
  const entries = Object.entries(value.assets);
  if (entries.length > MAX_IMAGES) throw new Error(`每篇离线资料最多保存 ${MAX_IMAGES} 张配图。`);
  const assets: Record<string, OfflineAsset> = {};
  for (const [path, asset] of entries) {
    if (!SAFE_ASSET.test(path) || !record(asset) || !SAFE_MIME.has(String(asset.mime)) || !validBase64(asset.base64)) {
      throw new Error("离线资料配图格式无效。");
    }
    assets[path] = { mime: asset.mime as OfflineAsset["mime"], base64: asset.base64 };
  }
  const cover = value.cover;
  if (cover !== undefined && (typeof cover !== "string" || (cover !== "" && !SAFE_ASSET.test(cover)))) {
    throw new Error("离线资料封面格式无效。");
  }
  const id = String(value.id);
  return {
    schema: 1,
    id,
    version: Number(value.version),
    title: value.title,
    description: value.description,
    date: value.date,
    category: value.category,
    tags: [...value.tags],
    readingMinutes: Number(value.readingMinutes),
    savedAt: Number(value.savedAt),
    expiresAt: Number(value.expiresAt),
    html: value.html,
    headings,
    ...(cover ? { cover } : {}),
    assets,
  };
}

export function assessVaultWrite(
  existing: readonly VaultRecordInfo[],
  next: VaultRecordInfo,
): { ok: true } | { ok: false; reason: "bundle" | "documents" | "total" } {
  if (!Number.isSafeInteger(next.bytes) || next.bytes < 1 || next.bytes > MAX_BUNDLE_BYTES) return { ok: false, reason: "bundle" };
  const previous = existing.find(item => item.id === next.id);
  if (!previous && existing.length >= MAX_DOCUMENTS) return { ok: false, reason: "documents" };
  const total = existing.reduce((sum, item) => sum + item.bytes, 0) - (previous?.bytes || 0) + next.bytes;
  return total > MAX_TOTAL_BYTES ? { ok: false, reason: "total" } : { ok: true };
}
