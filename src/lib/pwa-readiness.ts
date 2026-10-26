export async function waitForOfflineShellReady(timeoutMs = 10_000): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("此浏览器不支持离线应用外壳。");
  const ready = (async () => {
    const existing = await navigator.serviceWorker.getRegistration("/");
    const requested = existing || await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = requested.active?.state === "activated" ? requested : await navigator.serviceWorker.ready;
    const active = registration.active;
    if (!active || active.state !== "activated") throw new Error("离线外壳尚未启用。");
    const script = new URL(active.scriptURL);
    const scope = new URL(registration.scope);
    if (script.origin !== location.origin || script.pathname !== "/sw.js" || script.search || script.hash ||
        scope.origin !== location.origin || scope.pathname !== "/") {
      throw new Error("离线外壳来源不可信，已停止保存。");
    }
  })();
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("离线外壳尚未准备好，请保持联网并重试。")), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}
