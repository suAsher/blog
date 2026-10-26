import "../../styles/pwa.css";
import { validateStoredSnapshotsOnline } from "../../lib/offline-vault";
import { controllerChangeAction, reloadGuardPassed } from "../../lib/pwa-update";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface ReloadDetail { waitUntil(work: Promise<unknown>): void }
let installPrompt: InstallPromptEvent | undefined;
let waitingWorker: ServiceWorker | undefined;
let updateRequested = false;
let refreshAvailable = false;
let offerReload: (() => void) | undefined;
let dialogSequence = 0;

function button(label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "device-tool";
  node.textContent = label;
  return node;
}

function dialog(title: string, body: string): HTMLDialogElement {
  const node = document.createElement("dialog");
  node.className = "device-dialog";
  const heading = document.createElement("h2");
  heading.id = `device-dialog-title-${++dialogSequence}`;
  heading.textContent = title;
  node.setAttribute("aria-labelledby", heading.id);
  const copy = document.createElement("p");
  copy.textContent = body;
  const close = button("知道了");
  close.addEventListener("click", () => node.close());
  node.append(heading, copy, close);
  document.body.append(node);
  return node;
}

function manualInstallMessage(): string {
  const agent = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(agent)) return "在 Safari 中打开分享菜单，然后选择“添加到主屏幕”。离线资料仍需要单独设置本地口令。";
  if (/Firefox/i.test(agent)) return "此浏览器不会提供网页安装提示。可使用浏览器菜单中的“安装”或“添加到主屏幕”（若可用）。";
  return "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。如果没有该选项，请先确认正在使用 HTTPS。";
}

export async function waitForReloadGuards(timeoutMs = 15_000): Promise<void> {
  const work: Promise<unknown>[] = [];
  const event = new CustomEvent<ReloadDetail>("content:before-reload", {
    cancelable: true,
    detail: { waitUntil: promise => work.push(Promise.resolve(promise)) },
  });
  if (!document.dispatchEvent(event)) throw new Error("当前编辑尚未准备好重新载入。");
  if (!work.length) return;
  let timer: ReturnType<typeof setTimeout>;
  try {
    const results = await Promise.race([
      Promise.all(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("保存编辑内容超时，已取消更新。")), timeoutMs); }),
    ]);
    if (!reloadGuardPassed(results)) throw new Error("编辑内容尚未成功保存，已取消更新。");
  } finally { clearTimeout(timer!); }
}

function renderControls(registration?: ServiceWorkerRegistration): void {
  const slot = document.getElementById("device-tools");
  if (!slot || slot.dataset.pwaReady) return;
  slot.dataset.pwaReady = "true";
  const offline = document.createElement("a");
  offline.className = "device-tool";
  offline.href = "/offline/";
  offline.textContent = "离线阅读";
  const install = button("安装应用");
  install.id = "pwa-install";
  const installHelp = dialog("安装知识空间", manualInstallMessage());
  install.addEventListener("click", async () => {
    if (!installPrompt) { installHelp.showModal(); return; }
    const prompt = installPrompt;
    installPrompt = undefined;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") install.hidden = true;
  });
  const update = button("应用更新");
  update.hidden = true;
  const updateError = dialog("暂未更新", "编辑内容未能安全保存，应用没有重新载入。请确认内容保存后重试。");
  update.addEventListener("click", async () => {
    if (!waitingWorker && !refreshAvailable) return;
    update.disabled = true;
    try {
      await waitForReloadGuards();
      updateRequested = true;
      if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
      else location.reload();
    } catch (error) {
      updateError.querySelector("p")!.textContent = error instanceof Error ? error.message : "编辑内容未能安全保存，应用没有重新载入。";
      updateError.showModal();
      update.disabled = false;
    }
  });
  function offerUpdate(worker?: ServiceWorker | null) {
    if (!worker) return;
    waitingWorker = worker;
    update.hidden = false;
  }
  offerReload = () => {
    refreshAvailable = true;
    update.textContent = "刷新应用";
    update.hidden = false;
  };
  if (refreshAvailable) offerReload();
  offerUpdate(registration?.waiting);
  registration?.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) offerUpdate(worker);
    });
  });
  slot.append(offline, install, update);
}

function warnOfflineUnavailable(): void {
  const slot = document.getElementById("device-tools");
  if (!slot || slot.querySelector(".device-warning")) return;
  const warning = document.createElement("span");
  warning.className = "device-warning";
  warning.textContent = "此浏览器暂时无法使用离线资料";
  warning.setAttribute("role", "status");
  slot.append(warning);
}

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
});
window.addEventListener("appinstalled", () => {
  document.querySelector<HTMLButtonElement>("#pwa-install")?.toggleAttribute("hidden", true);
});

async function start(): Promise<void> {
  let registration: ServiceWorkerRegistration | undefined;
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    try {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (controllerChangeAction(updateRequested) === "reload") location.reload();
        else { refreshAvailable = true; offerReload?.(); }
      });
      registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      void registration.update();
    } catch { /* HTTPS or browser policy may intentionally disable installation. */ }
  }
  renderControls(registration);
  void validateStoredSnapshotsOnline().catch(warnOfflineUnavailable);
}

function startWhenIdle(): void {
  const run = () => void start();
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 750);
}
if (document.readyState === "complete") startWhenIdle();
else window.addEventListener("load", startWhenIdle, { once: true });
