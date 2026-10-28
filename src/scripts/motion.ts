import "../styles/visual.css";
import { motionPolicy, motionSurface } from "../lib/motion-capabilities";

const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = reduced.matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
const wideScene = matchMedia("(min-width: 768px)");
let hasFinePointer = finePointer.matches;
const html = document.documentElement;
const toggle = document.querySelector<HTMLButtonElement>(
  "[data-motion-toggle]",
);
let paused = false;
let controller: AbortController | undefined;
let generation = 0;
let ready = false;

function policy() {
  const device = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  };
  return motionPolicy({
    pathname: location.pathname,
    reduced: reducedMotion,
    finePointer: hasFinePointer,
    saveData: device.connection?.saveData === true,
    cores: device.hardwareConcurrency,
    memory: device.deviceMemory,
    viewportWidth: document.documentElement.clientWidth,
  });
}
function syncState() {
  const capabilities = policy();
  html.dataset.motion =
    reducedMotion ||
    document.hidden ||
    paused ||
    !(
      capabilities.scene ||
      capabilities.css ||
      capabilities.effects ||
      capabilities.smooth
    )
      ? "paused"
      : "active";
  if (toggle) {
    toggle.hidden = !(capabilities.scene || capabilities.css);
    toggle.setAttribute("aria-pressed", String(paused));
    const label = toggle.querySelector("[data-motion-label]");
    if (label) label.textContent = paused ? "继续动效" : "暂停动效";
    const symbol = toggle.querySelector(".motion-toggle-symbol");
    if (symbol) symbol.textContent = paused ? "▷" : "Ⅱ";
  }
  if (!(capabilities.scene || capabilities.effects || capabilities.smooth)) {
    if (capabilities.css) {
      html.dataset.visualRuntime = html.dataset.motion;
      html.dataset.visualEngine = "css";
    } else {
      delete html.dataset.visualRuntime;
      delete html.dataset.visualEngine;
    }
  } else {
    delete html.dataset.visualEngine;
  }
  document.dispatchEvent(new Event("knowledge:motion-change"));
}
async function mount() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const version = ++generation;
  syncState();
  const capabilities = policy();
  if (!ready) return;
  if (!(capabilities.scene || capabilities.smooth || capabilities.effects)) {
    const art = document.querySelector<HTMLElement>("[data-hero-art]");
    if (capabilities.css && art) {
      if (typeof IntersectionObserver === "undefined") {
        art.setAttribute("data-motion-offscreen", "");
      } else {
        const observer = new IntersectionObserver((entries) => {
          art.toggleAttribute(
            "data-motion-offscreen",
            !entries.some((entry) => entry.isIntersecting),
          );
        });
        observer.observe(art);
        signal.addEventListener(
          "abort",
          () => {
            observer.disconnect();
            art.removeAttribute("data-motion-offscreen");
          },
          { once: true },
        );
      }
    }
    return;
  }
  try {
    const { mountVisualRuntime } = await import("./visual/runtime");
    if (signal.aborted || version !== generation) return;
    await mountVisualRuntime(
      capabilities,
      signal,
      () => paused || reducedMotion,
    );
    if (!signal.aborted && version === generation) syncState();
  } catch {
    if (signal.aborted || version !== generation) return;
    // Content and the CSS constellation are already present if optional chunks fail.
    html.dataset.visualRuntime = "fallback";
    const scene = document.querySelector<HTMLElement>("[data-hero-scene]");
    if (scene) scene.dataset.sceneState = "fallback";
  }
}

toggle?.addEventListener("click", () => {
  paused = !paused;
  syncState();
});
reduced.addEventListener("change", (event) => {
  reducedMotion = event.matches;
  void mount();
});
finePointer.addEventListener("change", (event) => {
  hasFinePointer = event.matches;
  void mount();
});
wideScene.addEventListener("change", () => void mount());
document.addEventListener("visibilitychange", syncState);
window.addEventListener("pagehide", () => {
  controller?.abort();
  generation++;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void mount();
});
syncState();
if (motionSurface(location.pathname) !== "native") {
  // Two frames guarantee the static heading and controls can paint before optional engines load.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      ready = true;
      void mount();
    }),
  );
}
