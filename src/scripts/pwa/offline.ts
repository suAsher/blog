import {
  listSnapshots,
  lockVault,
  purgePrivateVault,
  readSnapshot,
  removeSnapshot,
  unlockVault,
  validateStoredSnapshotsOnline,
  vaultExists,
  vaultRecordCount,
} from "../../lib/offline-vault";
import { offlineDocumentId, prepareSnapshotFragment } from "../../lib/offline-snapshot";
import type { OfflineSnapshot } from "../../lib/offline-vault-model";

const locked = document.getElementById("offline-locked")!;
const library = document.getElementById("offline-library")!;
const reader = document.getElementById("offline-reader")!;
const list = document.getElementById("offline-list")!;
const status = document.getElementById("library-status")!;
const form = document.querySelector<HTMLFormElement>("#unlock-form")!;
const passphrase = document.querySelector<HTMLInputElement>("#offline-passphrase")!;
const confirmation = document.querySelector<HTMLInputElement>("#offline-confirm")!;
const consent = document.querySelector<HTMLInputElement>("#offline-consent")!;
const confirmRow = document.getElementById("confirm-row")!;
const consentRow = document.getElementById("consent-row")!;
const error = document.getElementById("unlock-error")!;
const body = document.getElementById("offline-body")!;
let snapshots: OfflineSnapshot[] = [];
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function setError(message = ""): void {
  error.textContent = message;
  error.hidden = !message;
}

function clearPrivateDOM(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  snapshots = [];
  list.replaceChildren();
  body.replaceChildren();
  document.getElementById("offline-document-title")!.textContent = "";
  document.getElementById("offline-description")!.textContent = "";
  document.getElementById("offline-meta")!.textContent = "";
  document.getElementById("offline-reader-status")!.textContent = "";
  document.getElementById("offline-tags")!.replaceChildren();
  document.getElementById("offline-toc")!.replaceChildren();
  const cover = document.querySelector<HTMLImageElement>("#offline-cover")!;
  cover.removeAttribute("src"); cover.alt = ""; cover.hidden = true;
  library.hidden = true;
  reader.hidden = true;
  locked.hidden = false;
  document.getElementById("vault-lock")!.hidden = true;
  passphrase.value = "";
  confirmation.value = "";
  document.title = "离线阅读 · asher 知识空间";
}

function expireVisibleSnapshots(now = Date.now()): boolean {
  const expired = snapshots.filter(snapshot => snapshot.expiresAt <= now);
  if (!expired.length) return false;
  // Clear plaintext synchronously, then remove the ciphertext records. The
  // lock broadcast makes every open viewer discard its own decrypted copies.
  lockVault(true);
  void Promise.all(expired.map(snapshot => removeSnapshot(snapshot.id, snapshot.savedAt)))
    .then(() => vaultRecordCount())
    .then(count => { document.getElementById("vault-count")!.textContent = `此设备保存了 ${count} 个加密资料包。解锁后才会显示标题。`; })
    .catch(cause => setError(cause instanceof Error ? cause.message : "已锁定过期资料，但未能完全清除。"));
  return true;
}

function scheduleNearestExpiry(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!snapshots.length) return;
  const delay = Math.max(0, Math.min(...snapshots.map(snapshot => snapshot.expiresAt)) - Date.now());
  expiryTimer = setTimeout(() => { expiryTimer = undefined; expireVisibleSnapshots(); }, delay);
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function renderLibrary(): void {
  if (expireVisibleSnapshots()) return;
  reader.hidden = true;
  library.hidden = false;
  status.textContent = snapshots.length ? `${snapshots.length} 篇 · 最长保存 7 天` : "还没有保存离线资料";
  list.replaceChildren(...snapshots.map(snapshot => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/offline/?id=${encodeURIComponent(snapshot.id)}`;
    link.dataset.offlineDocument = snapshot.id;
    const title = document.createElement("strong");
    title.textContent = snapshot.title;
    const detail = document.createElement("span");
    detail.textContent = `${snapshot.category || "文章"} · 保存于 ${formatDate(snapshot.savedAt)}`;
    link.append(title, detail);
    item.append(link);
    return item;
  }));
}

function addCodeCopy(): void {
  body.querySelectorAll<HTMLPreElement>("pre").forEach(pre => {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "offline-code-copy";
    copy.textContent = "复制代码";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || pre.textContent || "");
        copy.textContent = "已复制 ✓";
        setTimeout(() => { copy.textContent = "复制代码"; }, 1800);
      } catch {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(pre);
        selection?.removeAllRanges();
        selection?.addRange(range);
        copy.textContent = "已选中，请复制";
      }
    });
    pre.prepend(copy);
  });
}

async function renderDocument(id: string): Promise<void> {
  const snapshot = snapshots.find(item => item.id === id) || await readSnapshot(id);
  if (!snapshot) {
    renderLibrary();
    status.textContent = "这篇链接未保存在此设备，离线时无法创建或读取私人内容。恢复联网后再打开。";
    return;
  }
  if (snapshot.expiresAt <= Date.now()) {
    if (!snapshots.some(item => item.id === snapshot.id)) snapshots = [...snapshots, snapshot];
    expireVisibleSnapshots();
    return;
  }
  library.hidden = true;
  reader.hidden = false;
  document.getElementById("offline-document-title")!.textContent = snapshot.title;
  document.getElementById("offline-description")!.textContent = snapshot.description;
  document.getElementById("offline-meta")!.textContent = `${snapshot.category || "文章"} · ${snapshot.date.replaceAll("-", ".")} · ${snapshot.readingMinutes} 分钟`;
  document.getElementById("offline-tags")!.replaceChildren(...snapshot.tags.map(value => {
    const tag = document.createElement("span"); tag.textContent = `#${value}`; return tag;
  }));
  document.getElementById("offline-toc")!.replaceChildren(...snapshot.headings.map(heading => {
    const link = document.createElement("a"); link.href = `#${encodeURIComponent(heading.slug)}`; link.textContent = heading.text; return link;
  }));
  const cover = document.querySelector<HTMLImageElement>("#offline-cover")!;
  const coverAsset = snapshot.cover ? snapshot.assets[snapshot.cover] : undefined;
  if (coverAsset) {
    cover.src = `data:${coverAsset.mime};base64,${coverAsset.base64}`;
    cover.alt = `${snapshot.title} 封面`;
    cover.hidden = false;
  } else { cover.removeAttribute("src"); cover.hidden = true; }
  // Resource URLs are removed or rewritten inside the inert fragment before it
  // ever reaches the live DOM, so decryption cannot trigger an API request.
  body.replaceChildren(prepareSnapshotFragment(snapshot));
  addCodeCopy();
  document.getElementById("offline-reader-status")!.textContent = `保存于 ${formatDate(snapshot.savedAt)}；到期时间依赖此设备时钟。`;
  document.title = `${snapshot.title} · 离线阅读`;
  window.scrollTo({ top: 0, behavior: "instant" });
}

async function showRequestedView(): Promise<void> {
  const id = new URLSearchParams(location.search).get("id") || offlineDocumentId(location.pathname);
  if (id && /^[a-f0-9]{32}$/.test(id)) await renderDocument(id);
  else {
    renderLibrary();
    if (location.pathname.startsWith("/manage")) status.textContent = "写作与新建内容需要联网验证。离线时不会伪造保存成功。";
    else if (location.pathname !== "/offline/") status.textContent = "网络暂时不可用；这里只显示你明确保存到此设备的资料。";
  }
}

async function afterUnlock(): Promise<void> {
  snapshots = await listSnapshots();
  scheduleNearestExpiry();
  document.getElementById("vault-count")!.textContent = `此设备保存了 ${snapshots.length} 个加密资料包。解锁后才会显示标题。`;
  confirmRow.hidden = true;
  confirmation.hidden = true;
  confirmation.required = false;
  consentRow.hidden = true;
  consent.required = false;
  document.getElementById("unlock-submit")!.textContent = "解锁离线资料";
  locked.hidden = true;
  document.getElementById("vault-lock")!.hidden = false;
  await showRequestedView();
}

async function initialize(): Promise<void> {
  if (navigator.onLine) await validateStoredSnapshotsOnline();
  const exists = await vaultExists();
  const count = exists ? await vaultRecordCount() : 0;
  document.getElementById("vault-count")!.textContent = exists ? `此设备保存了 ${count} 个加密资料包。解锁后才会显示标题。` : "此设备还没有离线资料。请先在已发布文章中选择“保存离线”。";
  confirmRow.hidden = exists;
  confirmation.hidden = exists;
  consentRow.hidden = exists;
  confirmation.required = !exists;
  consent.required = !exists;
  document.getElementById("unlock-submit")!.textContent = exists ? "解锁离线资料" : "建立此设备的离线资料库";
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  setError();
  const submit = document.querySelector<HTMLButtonElement>("#unlock-submit")!;
  submit.disabled = true;
  try {
    await initialization;
    const exists = await vaultExists();
    if (!exists && passphrase.value !== confirmation.value) throw new Error("两次输入的离线口令不一致。");
    if (!exists && !consent.checked) throw new Error("请先确认离线撤回与设备时钟限制。");
    await unlockVault(passphrase.value, !exists);
    passphrase.value = "";
    confirmation.value = "";
    await afterUnlock();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "无法解锁离线资料。");
  } finally { submit.disabled = false; }
});

document.getElementById("vault-lock")!.addEventListener("click", () => lockVault(true));
document.getElementById("vault-clear")!.addEventListener("click", async () => {
  if (!confirm("清除此设备上的全部加密离线资料？收藏、主题与未保存编辑备份不会受影响。")) return;
  try {
    await purgePrivateVault();
    clearPrivateDOM();
    await initialize();
    setError("离线资料已从此设备清除。");
  } catch (cause) {
    clearPrivateDOM();
    setError(cause instanceof Error ? `资料已锁定，但未能完全清除：${cause.message}` : "资料已锁定，但未能完全清除。请关闭其他标签页后重试。");
  }
});

document.addEventListener("offline-vault:locked", clearPrivateDOM);
document.addEventListener("offline-vault:changed", () => void initialize().catch(cause => setError(cause instanceof Error ? cause.message : "无法更新此设备的离线资料库。")));
document.addEventListener("click", event => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link) return;
  const id = link.dataset.offlineDocument;
  if (id) {
    event.preventDefault();
    history.pushState({}, "", `/offline/?id=${encodeURIComponent(id)}`);
    void renderDocument(id);
    return;
  }
  if (link.classList.contains("back-link")) {
    event.preventDefault();
    history.pushState({}, "", "/offline/");
    renderLibrary();
    return;
  }
  const url = new URL(link.href);
  if (!navigator.onLine && url.origin === location.origin && !url.hash) {
    event.preventDefault();
    const message = "这个链接未保存在此设备。离线时无法打开私人页面或创建内容。";
    if (reader.hidden) status.textContent = message;
    else document.getElementById("offline-reader-status")!.textContent = message;
  }
});
window.addEventListener("popstate", () => void showRequestedView());

const initialSubmit = document.querySelector<HTMLButtonElement>("#unlock-submit")!;
initialSubmit.disabled = true;
const initialization = initialize().finally(() => { initialSubmit.disabled = false; });
void initialization.catch(cause => setError(cause instanceof Error ? cause.message : "无法读取此设备的离线资料库。"));
