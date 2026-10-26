import { gsap } from "gsap";
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { shouldAnimate } from "../../lib/motion-capabilities";
import type { motionPolicy } from "../../lib/motion-capabilities";
import type { mountEffects } from "./effects";
import type { mountNebula } from "./nebula";

type Policy = ReturnType<typeof motionPolicy>;

/** This surface owns the GSAP ticker; it advances Lenis, pointer effects and OGL. */
export async function mountVisualRuntime(
  policy: Policy,
  signal: AbortSignal,
  isPaused: () => boolean,
) {
  const html = document.documentElement;
  const host = document.querySelector<HTMLElement>("[data-hero-scene]");
  const art = document.querySelector<HTMLElement>("[data-hero-art]");
  let scene: ReturnType<typeof mountNebula> | undefined;
  let effects: ReturnType<typeof mountEffects> | undefined;
  let effectsFactory: typeof mountEffects | undefined;
  let sceneVisible = true;
  let disposed = false;
  let mounted = false;
  let active: boolean | undefined;
  let lenis: Lenis | undefined;
  let intersection: IntersectionObserver | undefined;
  const sceneAllowed = () =>
    shouldAnimate({
      allowed: policy.scene && !!scene,
      hidden: document.hidden,
      onscreen: sceneVisible,
      paused: isPaused(),
    });
  const fallback = () => {
    scene?.dispose();
    scene = undefined;
    if (host) host.dataset.sceneState = "fallback";
    art?.setAttribute("data-scene-unavailable", "");
    if (mounted) sync();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    active = false;
    gsap.ticker.remove(tick);
    intersection?.disconnect();
    effects?.dispose();
    destroyScroll();
    scene?.dispose();
    scene = undefined;
    if (host) host.dataset.sceneState = "fallback";
    delete html.dataset.visualRuntime;
    gsap.ticker.sleep();
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (signal.aborted) {
    dispose();
    return;
  }
  if (host && policy.scene) {
    try {
      const { mountNebula } = await import("./nebula");
      if (signal.aborted) return;
      scene = mountNebula(host, fallback);
      art?.removeAttribute("data-scene-unavailable");
    } catch {
      fallback();
    }
  }
  if (policy.effects) {
    try {
      const module = await import("./effects");
      if (signal.aborted) {
        scene?.dispose();
        return;
      }
      effectsFactory = module.mountEffects;
    } catch (error) {
      scene?.dispose();
      throw error;
    }
  }
  const createScroll = () => {
    if (!policy.smooth || lenis) return;
    lenis = new Lenis({
      autoRaf: false,
      smoothWheel: true,
      syncTouch: false,
      lerp: 0.11,
      allowNestedScroll: true,
      anchors: true,
      prevent: (node) =>
        !!node.closest(
          'dialog,[data-lenis-prevent],textarea,select,[contenteditable="true"]',
        ),
      virtualScroll: (data) =>
        !data.event.ctrlKey && !document.querySelector("dialog[open]"),
    });
    lenis.on("scroll", () => effects?.updateScroll());
    html.dataset.smoothScroll = "active";
  };
  function destroyScroll() {
    lenis?.destroy();
    lenis = undefined;
    delete html.dataset.smoothScroll;
  }
  function tick(time: number) {
    if (!active || disposed) return;
    lenis?.raf(time * 1000);
    effects?.frame();
    if (sceneAllowed()) scene?.render(time);
  }
  function sync() {
    if (disposed || signal.aborted) return;
    const running =
      !document.hidden &&
      !isPaused() &&
      (policy.smooth || policy.effects || (sceneVisible && !!scene));
    if (host && scene) {
      host.dataset.sceneState = sceneAllowed() ? "active" : "paused";
      if (!sceneAllowed()) scene.pause();
    }
    if (running === active) return;
    active = running;
    html.dataset.visualRuntime = running ? "active" : "paused";
    if (running) {
      if (effectsFactory && !effects) effects = effectsFactory(signal);
      createScroll();
      effects?.resume();
      gsap.ticker.add(tick);
      gsap.ticker.wake();
    } else {
      gsap.ticker.remove(tick);
      effects?.pause();
      destroyScroll();
      gsap.ticker.sleep();
    }
  }
  intersection = art
    ? new IntersectionObserver(
        (entries) => {
          sceneVisible = !!entries[0]?.isIntersecting;
          art?.toggleAttribute("data-motion-offscreen", !sceneVisible);
          sync();
        },
        { threshold: 0 },
      )
    : undefined;
  if (art) intersection?.observe(art);
  art?.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse" || !sceneAllowed()) return;
      const rect = art.getBoundingClientRect();
      scene?.pointer(
        (event.clientX - rect.left) / rect.width - 0.5,
        0.5 - (event.clientY - rect.top) / rect.height,
      );
    },
    { passive: true, signal },
  );
  art?.addEventListener("pointerleave", () => scene?.pointer(0, 0), { signal });
  document.addEventListener("visibilitychange", sync, { signal });
  document.addEventListener("knowledge:motion-change", sync, { signal });
  mounted = true;
  sync();
  return { dispose, sync };
}
