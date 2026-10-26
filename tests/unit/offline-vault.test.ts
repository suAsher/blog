import { describe, expect, it } from "vitest";
import {
  MAX_BUNDLE_BYTES,
  MAX_DOCUMENTS,
  MAX_IMAGES,
  MAX_TOTAL_BYTES,
  SNAPSHOT_TTL_MS,
  assessVaultWrite,
  validateSnapshot,
  withinPersistedVaultBudget,
  type OfflineSnapshot,
} from "../../src/lib/offline-vault-model";
import {
  createVaultSalt,
  decryptVaultPayload,
  deriveVaultKey,
  encryptVaultPayload,
} from "../../src/lib/vault-crypto";
import {
  classifyValidationResponse,
  isCanonicalAssetResponse,
  offlineDocumentId,
  safeSnapshotAssetPath,
} from "../../src/lib/offline-snapshot";
import { validateStoredBundleHeader } from "../../src/lib/offline-vault";

const id = "0123456789abcdef0123456789abcdef";
const snapshot = (overrides: Partial<OfflineSnapshot> = {}): OfflineSnapshot => ({
  schema: 1,
  id,
  version: 3,
  title: "离线文章",
  description: "仅保留投影后的发布快照",
  date: "2026-10-26",
  category: "笔记",
  tags: ["离线"],
  readingMinutes: 4,
  savedAt: 1_000,
  expiresAt: 1_000 + SNAPSHOT_TTL_MS,
  html: "<h2 id=\"safe\">安全正文</h2>",
  headings: [{ depth: 2, slug: "safe", text: "安全正文" }],
  assets: {},
  ...overrides,
});

describe("offline vault cryptography", () => {
  it("round-trips a projected snapshot with a non-extractable memory key", async () => {
    const salt = createVaultSalt();
    const key = await deriveVaultKey("a separate local passphrase", salt);
    expect(key.extractable).toBe(false);
    const encrypted = await encryptVaultPayload(key, snapshot());
    expect(await decryptVaultPayload(key, encrypted)).toEqual(snapshot());
  });

  it("uses a unique 96-bit IV for every encryption", async () => {
    const key = await deriveVaultKey("a separate local passphrase", createVaultSalt());
    const first = await encryptVaultPayload(key, snapshot());
    const second = await encryptVaultPayload(key, snapshot());
    expect(first.iv).toHaveLength(16);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects a different passphrase without returning plaintext", async () => {
    const salt = createVaultSalt();
    const encrypted = await encryptVaultPayload(
      await deriveVaultKey("correct local passphrase", salt),
      snapshot(),
    );
    await expect(
      decryptVaultPayload(
        await deriveVaultKey("wrong local passphrase", salt),
        encrypted,
      ),
    ).rejects.toThrow("无法解锁离线资料");
  });
});

describe("offline snapshot validation and budgets", () => {
  it("rejects corrupt plaintext IDB headers before decrypting, budgeting or fetching", () => {
    const valid = {
      id, version: 1, savedAt: 1_000, expiresAt: 1_000 + SNAPSHOT_TTL_MS,
      bytes: 29, iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA=",
    };
    expect(validateStoredBundleHeader(valid)).toEqual(valid);
    for (const corrupt of [
      { ...valid, id: "/api/private" },
      { ...valid, bytes: Number.NaN },
      { ...valid, bytes: MAX_BUNDLE_BYTES + 1 },
      { ...valid, expiresAt: valid.expiresAt + 1 },
      { ...valid, iv: "not-base64" },
      { ...valid, ciphertext: "A".repeat(100) },
    ]) expect(() => validateStoredBundleHeader(corrupt)).toThrow("索引损坏");
  });
  it("accepts the bounded projected structure and returns fresh copies", () => {
    const input = snapshot();
    const validated = validateSnapshot(input, 1_001);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validated.tags).not.toBe(input.tags);
  });

  it("rejects expired, oversized, executable or malformed decrypted values", () => {
    expect(() => validateSnapshot(snapshot(), 1_000 + SNAPSHOT_TTL_MS + 1)).toThrow("已过期");
    expect(() => validateSnapshot(snapshot({ html: `<script>alert(1)</script>` }), 1_001)).toThrow("不安全");
    expect(() => validateSnapshot(snapshot({ html: `<p style="background:url('/api/private')">x</p>` }), 1_001)).toThrow("不安全");
    expect(() => validateSnapshot(snapshot({ assets: Object.fromEntries(Array.from({ length: MAX_IMAGES + 1 }, (_, index) => [`/api/assets/${index}.png`, { mime: "image/png", base64: "AA==" }])) }), 1_001)).toThrow("配图");
    expect(() => validateSnapshot({ ...snapshot(), id: "../private" }, 1_001)).toThrow("格式");
  });

  it("enforces document, per-bundle and aggregate encrypted budgets", () => {
    expect(assessVaultWrite([], { id, bytes: MAX_BUNDLE_BYTES })).toEqual({ ok: true });
    expect(assessVaultWrite([], { id, bytes: MAX_BUNDLE_BYTES + 1 })).toEqual({ ok: false, reason: "bundle" });
    const full = Array.from({ length: MAX_DOCUMENTS }, (_, index) => ({ id: index.toString(16).padStart(32, "0"), bytes: 1 }));
    expect(assessVaultWrite(full, { id: "f".repeat(32), bytes: 1 })).toEqual({ ok: false, reason: "documents" });
    expect(assessVaultWrite([{ id, bytes: MAX_TOTAL_BYTES - 4 }], { id: "f".repeat(32), bytes: 5 })).toEqual({ ok: false, reason: "total" });
    expect(assessVaultWrite([{ id, bytes: 99 }], { id, bytes: 25 })).toEqual({ ok: true });
    expect(withinPersistedVaultBudget(MAX_DOCUMENTS, MAX_TOTAL_BYTES)).toBe(true);
    expect(withinPersistedVaultBudget(MAX_DOCUMENTS + 1, 1)).toBe(false);
    expect(withinPersistedVaultBudget(4, MAX_TOTAL_BYTES + 1)).toBe(false);
  });
});

describe("offline routing and online validation policy", () => {
  it("recognizes only canonical published document and same-origin raster asset paths", () => {
    expect(offlineDocumentId(`/articles/${id}/`)).toBe(id);
    expect(offlineDocumentId(`/manage/?id=${id}`)).toBeNull();
    expect(safeSnapshotAssetPath(`/api/assets/${"a".repeat(64)}.png`, "https://knowledge.test")).toBe(`/api/assets/${"a".repeat(64)}.png`);
    expect(safeSnapshotAssetPath("https://evil.test/pixel.png", "https://knowledge.test")).toBeNull();
    expect(safeSnapshotAssetPath("/api/documents/private", "https://knowledge.test")).toBeNull();
    expect(safeSnapshotAssetPath(`/api/assets/${"a".repeat(64)}.svg`, "https://knowledge.test")).toBeNull();
  });

  it("accepts only an exact same-origin basic response for a requested asset", () => {
    const path = `/api/assets/${"a".repeat(64)}.png`;
    expect(isCanonicalAssetResponse({ ok: true, type: "basic", url: `https://knowledge.test${path}` }, path, "https://knowledge.test")).toBe(true);
    expect(isCanonicalAssetResponse({ ok: true, type: "basic", url: `https://knowledge.test${path}?leak=1` }, path, "https://knowledge.test")).toBe(false);
    expect(isCanonicalAssetResponse({ ok: true, type: "basic", url: `https://knowledge.test/login/` }, path, "https://knowledge.test")).toBe(false);
    expect(isCanonicalAssetResponse({ ok: true, type: "cors", url: `https://cdn.test${path}` }, path, "https://knowledge.test")).toBe(false);
    expect(isCanonicalAssetResponse({ ok: false, type: "basic", url: `https://knowledge.test${path}` }, path, "https://knowledge.test")).toBe(false);
  });

  it("purges only authoritative withdrawal, authorization, or version evidence", () => {
    expect(classifyValidationResponse(200, 3, 3)).toBe("keep");
    expect(classifyValidationResponse(200, 4, 3)).toBe("purge-record");
    expect(classifyValidationResponse(404)).toBe("purge-record");
    expect(classifyValidationResponse(401)).toBe("purge-all");
    expect(classifyValidationResponse(302)).toBe("purge-all");
    expect(classifyValidationResponse(403)).toBe("purge-all");
    expect(classifyValidationResponse(0)).toBe("defer");
    expect(classifyValidationResponse(503)).toBe("defer");
  });
});
