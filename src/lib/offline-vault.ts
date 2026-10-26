import { MAX_BUNDLE_BYTES, SNAPSHOT_TTL_MS, assessVaultWrite, validateSnapshot, withinPersistedVaultBudget, type OfflineSnapshot } from "./offline-vault-model";
import { createVaultSalt, decryptVaultPayload, deriveVaultKey, encryptVaultPayload } from "./vault-crypto";

const DATABASE = "asher-private-offline-v1";
const VERSION = 1;
const BUNDLES = "bundles";
const META = "meta";
const CHANNEL = "asher-private-offline";

interface StoredBundle {
  // Deliberately minimal plaintext header: opaque ID, published revision,
  // timestamps, encrypted byte size and IV. Titles, tags, HTML and every image
  // remain exclusively inside authenticated ciphertext.
  id: string;
  version: number;
  savedAt: number;
  expiresAt: number;
  bytes: number;
  iv: string;
  ciphertext: string;
}

interface MetaValue { key: string; value: string }
let memoryKey: CryptoKey | undefined;
let vaultEpoch = 0;

function requireEpoch(epoch: number): void {
  if (epoch !== vaultEpoch) throw new Error("离线资料已锁定，本次操作已取消。");
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodedBase64Bytes(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return -1;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (value.endsWith("==") && (alphabet.indexOf(value.at(-3) || "") & 15) !== 0) return -1;
  if (value.endsWith("=") && !value.endsWith("==") && (alphabet.indexOf(value.at(-2) || "") & 3) !== 0) return -1;
  return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}

function encryptedBytes(record: { iv: string; ciphertext: string }): number {
  const iv = decodedBase64Bytes(record.iv);
  const ciphertext = decodedBase64Bytes(record.ciphertext);
  return iv < 0 || ciphertext < 0 ? -1 : iv + ciphertext;
}

export function validateStoredBundleHeader(value: unknown): StoredBundle {
  if (!object(value) || !/^[a-f0-9]{32}$/.test(String(value.id)) ||
      !Number.isSafeInteger(value.version) || Number(value.version) < 1 ||
      !Number.isSafeInteger(value.savedAt) || Number(value.savedAt) < 0 ||
      !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) - Number(value.savedAt) !== SNAPSHOT_TTL_MS ||
      !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 29 || Number(value.bytes) > MAX_BUNDLE_BYTES ||
      typeof value.iv !== "string" || value.iv.length !== 16 || decodedBase64Bytes(value.iv) !== 12 ||
      typeof value.ciphertext !== "string" || value.ciphertext.length > Math.ceil(MAX_BUNDLE_BYTES / 3) * 4 ||
      decodedBase64Bytes(value.ciphertext) < 17 || encryptedBytes({ iv: value.iv, ciphertext: value.ciphertext }) !== value.bytes) {
    throw new Error("离线资料索引损坏，已拒绝读取。");
  }
  return {
    id: String(value.id), version: Number(value.version), savedAt: Number(value.savedAt),
    expiresAt: Number(value.expiresAt), bytes: Number(value.bytes), iv: value.iv, ciphertext: value.ciphertext,
  };
}

function validateMeta(value: unknown, key: "salt" | "verifier"): string | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || value.key !== key || typeof value.value !== "string") throw new Error("离线资料库元数据损坏。");
  if (key === "salt") {
    if (value.value.length !== 24 || decodedBase64Bytes(value.value) !== 16) throw new Error("离线资料库盐值损坏。");
  } else {
    if (value.value.length > 4096) throw new Error("离线资料库验证信息损坏。");
    let parsed: unknown;
    try { parsed = JSON.parse(value.value); } catch { throw new Error("离线资料库验证信息损坏。"); }
    if (!object(parsed) || typeof parsed.iv !== "string" || parsed.iv.length !== 16 || decodedBase64Bytes(parsed.iv) !== 12 ||
        typeof parsed.ciphertext !== "string" || decodedBase64Bytes(parsed.ciphertext) < 17 || decodedBase64Bytes(parsed.ciphertext) > 1024) {
      throw new Error("离线资料库验证信息损坏。");
    }
  }
  return value.value;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("离线资料库不可用。")), { once: true });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("离线资料库操作失败。")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("离线资料库操作失败。")), { once: true });
  });
}

async function readBoundedJSON(response: Response, limit = 16 * 1024): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error("离线版本响应过大。");
  if (!response.body) throw new Error("离线版本响应不可读。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error("离线版本响应过大。"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function openVault(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("此浏览器不支持加密离线资料。");
  const request = indexedDB.open(DATABASE, VERSION);
  request.addEventListener("upgradeneeded", () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(BUNDLES)) db.createObjectStore(BUNDLES, { keyPath: "id" });
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
  });
  return requestResult(request);
}

async function getMeta(db: IDBDatabase, key: string): Promise<string | undefined> {
  if (key !== "salt" && key !== "verifier") throw new Error("未知的离线资料库元数据。");
  const result = await requestResult(db.transaction(META).objectStore(META).get(key));
  return validateMeta(result, key);
}

async function ensureMeta(db: IDBDatabase, key: "salt" | "verifier", value: string): Promise<string> {
  const tx = db.transaction(META, "readwrite");
  const store = tx.objectStore(META);
  const request = store.get(key);
  let selected: unknown;
  request.addEventListener("success", () => {
    selected = request.result;
    if (selected === undefined) {
      selected = { key, value } satisfies MetaValue;
      store.add(selected);
    }
  }, { once: true });
  await transactionDone(tx);
  const validated = validateMeta(selected, key);
  if (!validated) throw new Error("无法建立离线资料库元数据。");
  return validated;
}

async function exclusiveVaultOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("asher-private-offline-v1", { mode: "exclusive" }, operation);
  }
  return operation();
}

function boundedRecords(store: IDBObjectStore): Promise<StoredBundle[]> {
  return new Promise((resolve, reject) => {
    const records: StoredBundle[] = [];
    let bytes = 0;
    const request = store.openCursor();
    request.addEventListener("error", () => reject(request.error || new Error("离线资料库不可用。")), { once: true });
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (!cursor) { resolve(records); return; }
      try {
        const record = validateStoredBundleHeader(cursor.value);
        const nextBytes = bytes + record.bytes;
        if (!withinPersistedVaultBudget(records.length + 1, nextBytes)) {
          reject(new Error("离线资料库超过安全上限。请清除此设备资料后重新建立。"));
          return;
        }
        records.push(record);
        bytes = nextBytes;
        cursor.continue();
      } catch (cause) { reject(cause); }
    });
  });
}

async function allRecords(db: IDBDatabase): Promise<StoredBundle[]> {
  return boundedRecords(db.transaction(BUNDLES).objectStore(BUNDLES));
}

function requireKey(): CryptoKey {
  if (!memoryKey) throw new Error("请先使用此设备的离线口令解锁。");
  return memoryKey;
}

export function vaultUnlocked(): boolean { return Boolean(memoryKey); }

export async function vaultExists(): Promise<boolean> {
  return exclusiveVaultOperation(vaultExistsExclusive);
}

async function vaultExistsExclusive(): Promise<boolean> {
  const db = await openVault();
  try {
    const [salt, verifier, bundles] = await Promise.all([getMeta(db, "salt"), getMeta(db, "verifier"), allRecords(db)]);
    if (Boolean(salt) !== Boolean(verifier) || (!salt && bundles.length)) throw new Error("离线资料库不完整。请清除此设备资料后重新建立。");
    return Boolean(salt && verifier);
  } finally { db.close(); }
}

export async function unlockVault(passphrase: string, create = false): Promise<void> {
  const epoch = vaultEpoch;
  return exclusiveVaultOperation(() => unlockVaultExclusive(passphrase, create, epoch));
}

async function unlockVaultExclusive(passphrase: string, create: boolean, epoch: number): Promise<void> {
  requireEpoch(epoch);
  const db = await openVault();
  try {
    let salt = await getMeta(db, "salt");
    let verifier = await getMeta(db, "verifier");
    const bundleCount = await requestResult(db.transaction(BUNDLES).objectStore(BUNDLES).count());
    if (Boolean(salt) !== Boolean(verifier) || (!salt && bundleCount > 0)) {
      throw new Error("离线资料库不完整。请清除此设备资料后重新建立。");
    }
    if (!salt) {
      if (!create) throw new Error("此设备还没有离线资料库。");
      salt = await ensureMeta(db, "salt", createVaultSalt());
      requireEpoch(epoch);
    }
    const key = await deriveVaultKey(passphrase, salt);
    requireEpoch(epoch);
    if (!verifier) {
      if (!create) throw new Error("离线资料库不完整，请重新建立。");
      const encrypted = await encryptVaultPayload(key, { vault: "asher-private-v1" });
      verifier = await ensureMeta(db, "verifier", JSON.stringify(encrypted));
      requireEpoch(epoch);
    }
    const result = await decryptVaultPayload(key, JSON.parse(verifier));
    if (!result || typeof result !== "object" || (result as { vault?: unknown }).vault !== "asher-private-v1") throw new Error("无法解锁离线资料。");
    requireEpoch(epoch);
    memoryKey = key;
  } finally { db.close(); }
}

export function lockVault(notify = false): void {
  vaultEpoch++;
  memoryKey = undefined;
  if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("offline-vault:locked"));
  if (notify) postVaultMessage("lock");
}

export async function vaultRecordCount(): Promise<number> {
  const db = await openVault();
  try { return await requestResult(db.transaction(BUNDLES).objectStore(BUNDLES).count()); } finally { db.close(); }
}

export async function saveSnapshot(snapshot: OfflineSnapshot): Promise<void> {
  const validated = validateSnapshot(snapshot);
  const epoch = vaultEpoch;
  const key = requireKey();
  const encrypted = await encryptVaultPayload(key, validated);
  requireEpoch(epoch);
  const record: StoredBundle = {
    id: validated.id,
    version: validated.version,
    savedAt: validated.savedAt,
    expiresAt: validated.expiresAt,
    bytes: encryptedBytes(encrypted),
    ...encrypted,
  };
  await exclusiveVaultOperation(async () => {
  requireEpoch(epoch);
  const db = await openVault();
  try {
    // A single readwrite transaction serializes the quota decision with the
    // write across tabs. Splitting getAll() and put() would allow two tabs to
    // independently approve writes that exceed the document or byte cap.
    const tx = db.transaction(BUNDLES, "readwrite");
    const store = tx.objectStore(BUNDLES);
    let existing: StoredBundle[];
    try { existing = await boundedRecords(store); }
    catch (cause) {
      try { tx.abort(); } catch { /* The transaction may already have closed. */ }
      throw cause;
    }
    const assessment = assessVaultWrite(existing, record);
    if (!assessment.ok) {
      tx.abort();
      throw new Error({ bundle: "单篇离线资料最多占用 16 MiB。", documents: "此设备最多保存 20 篇离线资料。", total: "此设备的离线资料总计最多占用 50 MiB。" }[assessment.reason]);
    }
    requireEpoch(epoch);
    store.put(record);
    await transactionDone(tx);
  } finally { db.close(); }
  });
}

async function decryptRecord(record: StoredBundle, now = Date.now()): Promise<OfflineSnapshot> {
  const value = await decryptVaultPayload(requireKey(), record);
  const snapshot = validateSnapshot(value, now);
  if (snapshot.id !== record.id || snapshot.version !== record.version || snapshot.savedAt !== record.savedAt || snapshot.expiresAt !== record.expiresAt) {
    throw new Error("离线资料索引与加密内容不一致。");
  }
  return snapshot;
}

export async function listSnapshots(now = Date.now()): Promise<OfflineSnapshot[]> {
  const epoch = vaultEpoch;
  requireKey();
  const db = await openVault();
  try {
    const records = await allRecords(db);
    const expired = records.filter(record => record.expiresAt <= now).map(record => record.id);
    if (expired.length) {
      const tx = db.transaction(BUNDLES, "readwrite");
      expired.forEach(id => tx.objectStore(BUNDLES).delete(id));
      await transactionDone(tx);
    }
    const active = records.filter(record => record.expiresAt > now);
    const snapshots = await Promise.all(active.map(record => decryptRecord(record, now)));
    requireEpoch(epoch);
    return snapshots.sort((left, right) => right.savedAt - left.savedAt);
  } finally { db.close(); }
}

export async function readSnapshot(id: string, now = Date.now()): Promise<OfflineSnapshot | undefined> {
  if (!/^[a-f0-9]{32}$/.test(id)) return undefined;
  const epoch = vaultEpoch;
  requireKey();
  const db = await openVault();
  try {
    const value = await requestResult(db.transaction(BUNDLES).objectStore(BUNDLES).get(id));
    if (!value) return undefined;
    const record = validateStoredBundleHeader(value);
    if (record.expiresAt <= now) {
      const tx = db.transaction(BUNDLES, "readwrite");
      tx.objectStore(BUNDLES).delete(id);
      await transactionDone(tx);
      return undefined;
    }
    const snapshot = await decryptRecord(record, now);
    requireEpoch(epoch);
    return snapshot;
  } finally { db.close(); }
}

export async function removeSnapshot(id: string, expectedSavedAt?: number): Promise<void> {
  const db = await openVault();
  try {
    const tx = db.transaction(BUNDLES, "readwrite");
    const store = tx.objectStore(BUNDLES);
    if (expectedSavedAt === undefined) store.delete(id);
    else {
      const value = await requestResult(store.get(id));
      if (value && validateStoredBundleHeader(value).savedAt === expectedSavedAt) store.delete(id);
    }
    await transactionDone(tx);
  } finally { db.close(); }
}

async function deleteVaultDatabase(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.addEventListener("success", () => resolve(), { once: true });
    request.addEventListener("blocked", () => reject(new Error("请关闭其他标签页后重试清除离线资料。")), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("无法清除离线资料。")), { once: true });
  });
}

let channel: BroadcastChannel | undefined;
function postVaultMessage(type: "lock" | "purge" | "evict", ids?: string[]): void {
  try { channel?.postMessage({ type, ...(ids ? { ids } : {}) }); } catch { /* Privacy policy can revoke this channel at runtime. */ }
}
function broadcastPurge(): void {
  postVaultMessage("purge");
}

export async function purgePrivateVault(notify = true): Promise<void> {
  lockVault();
  if (notify) broadcastPurge();
  await exclusiveVaultOperation(deleteVaultDatabase);
}

export async function validateStoredSnapshotsOnline(): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  const epoch = vaultEpoch;
  const db = await openVault();
  let records: StoredBundle[];
  try {
    records = await allRecords(db);
  } finally { db.close(); }
  if (!records.length) return;
  let revisions: { id: string; available: boolean; version?: number }[];
  const controller = new AbortController();
  const validationTimeout = setTimeout(() => controller.abort(), 8_000);
  let response: Response;
  try {
    response = await fetch(`/api/offline-revisions?ids=${records.map(record => record.id).join(",")}`, {
      credentials: "same-origin", cache: "no-store", redirect: "manual", signal: controller.signal,
    });
  } catch {
    clearTimeout(validationTimeout);
    return;
  }
  if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    clearTimeout(validationTimeout);
    // Authoritative loss of access must remain an error if durable deletion is
    // blocked; otherwise the initial unlock view could reopen stale ciphertext.
    await purgePrivateVault();
    return;
  }
  if (response.status !== 200) { clearTimeout(validationTimeout); return; }
  try {
      const payload = await readBoundedJSON(response) as { ok?: unknown; data?: { revisions?: unknown } };
      if (payload.ok !== true || !Array.isArray(payload.data?.revisions) || payload.data.revisions.length !== records.length) return;
      revisions = payload.data.revisions.map((value, index) => {
        if (!object(value) || value.id !== records[index].id || typeof value.available !== "boolean") throw new Error();
        if (value.available && (!Number.isSafeInteger(value.version) || Number(value.version) < 1)) throw new Error();
        if (!value.available && value.version !== undefined) throw new Error();
        return { id: value.id, available: value.available, ...(value.available ? { version: Number(value.version) } : {}) };
      });
  } catch { return; }
  finally { clearTimeout(validationTimeout); }
    const purge = records.filter((record, index) => !revisions[index].available || revisions[index].version !== record.version);
    if (purge.length) {
      const deleted = await exclusiveVaultOperation(async () => {
        requireEpoch(epoch);
        const currentDB = await openVault();
        const removed: string[] = [];
        try {
          const tx = currentDB.transaction(BUNDLES, "readwrite");
          const store = tx.objectStore(BUNDLES);
          try {
            for (const expected of purge) {
              const value = await requestResult(store.get(expected.id));
              if (!value) continue;
              const current = validateStoredBundleHeader(value);
              if (current.version === expected.version && current.savedAt === expected.savedAt) {
                store.delete(current.id);
                removed.push(current.id);
              }
            }
            requireEpoch(epoch);
            await transactionDone(tx);
          } catch (cause) {
            try { tx.abort(); } catch { /* The transaction may already have closed. */ }
            throw cause;
          }
          return removed;
        } finally { currentDB.close(); }
      });
      // A committed authoritative revocation must invalidate every decrypted
      // copy immediately, including arrays/DOM held by other open tabs.
      if (deleted.length > 0) {
        const ids = deleted;
        lockVault(false);
        if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("offline-vault:changed", { detail: { ids } }));
        postVaultMessage("evict", ids);
      }
    }
}

if (typeof window !== "undefined") {
  try { channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : undefined; }
  catch { channel = undefined; }
  channel?.addEventListener("message", event => {
    if (event.data?.type === "purge") void purgePrivateVault(false);
    if (event.data?.type === "lock") lockVault(false);
    if (event.data?.type === "evict") {
      lockVault(false);
      document.dispatchEvent(new CustomEvent("offline-vault:changed", { detail: { ids: event.data.ids } }));
    }
  });
  window.addEventListener("pagehide", () => lockVault(false));
  window.addEventListener("online", () => void validateStoredSnapshotsOnline().catch(() => undefined));
}
if (typeof document !== "undefined") {
  document.addEventListener("auth:clear", event => {
    lockVault();
    const detail = (event as CustomEvent<{ waitUntil?: (work: Promise<unknown>) => void }>).detail;
    detail?.waitUntil?.(purgePrivateVault());
  });
}
