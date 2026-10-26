const PBKDF2_ITERATIONS = 310_000;

export interface EncryptedVaultPayload {
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, maximumBytes: number): Uint8Array<ArrayBuffer> {
  try {
    if (value.length > Math.ceil(maximumBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error();
    const binary = atob(value);
    if (binary.length > maximumBytes) throw new Error();
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    throw new Error("加密资料格式无效。");
  }
}

export function createVaultSalt(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveVaultKey(passphrase: string, salt: string): Promise<CryptoKey> {
  if (passphrase.length < 10 || passphrase.length > 1024) throw new Error("离线口令需要 10–1024 个字符。");
  if (salt.length !== 24) throw new Error("离线资料盐值无效。");
  const saltBytes = base64ToBytes(salt, 16);
  if (saltBytes.byteLength !== 16) throw new Error("离线资料盐值无效。");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: PBKDF2_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVaultPayload(key: CryptoKey, value: unknown): Promise<EncryptedVaultPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptVaultPayload(key: CryptoKey, payload: EncryptedVaultPayload): Promise<unknown> {
  try {
    if (payload.iv.length !== 16) throw new Error();
    const iv = base64ToBytes(payload.iv, 12);
    if (iv.byteLength !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(payload.ciphertext, 16 * 1024 * 1024),
    );
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new Error("无法解锁离线资料。请确认口令正确，或清除此设备上的离线资料。");
  }
}
