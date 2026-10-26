import {
  createAnimationClock,
  createTickerClock,
  type AnimationClock,
} from "../../lib/animation-clock";
import { shouldAnimate } from "../../lib/motion-capabilities";
import type { motionPolicy } from "../../lib/motion-capabilities";
import type { mountEffects } from "./effects";
import type { mountNebula } from "./nebula";
import type { mountSmoothScroll } from "./smooth-scroll";

type Policy = ReturnType<typeof motionPolicy>;

/** This surface owns exactly one clock; optional engines only provide adapters. */
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
  let scrollFactory: typeof mountSmoothScroll | undefined;
  let smoothScroll: ReturnType<typeof mountSmoothScroll> | undefined;
  let clock: AnimationClock | undefined;
  let sceneVisible = true;
  let disposed = false;
  let mounted = false;
  let active: boolean | undefined;
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
    intersection?.disconnect();
    destroyScroll();
    scene?.dispose();
    scene = undefined;
    effects?.dispose();
    effects = undefined;
    clock?.stop();
    if (host) host.dataset.sceneState = "fallback";
    delete html.dataset.visualRuntime;
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
  try {
    const [effectsModule, scrollModule] = await Promise.all([
      policy.effects ? import("./effects") : Promise.resolve(undefined),
      policy.smooth ? import("./smooth-scroll") : Promise.resolve(undefined),
    ]);
    if (signal.aborted) return;
    effectsFactory = effectsModule?.mountEffects;
    scrollFactory = scrollModule?.mountSmoothScroll;
    clock = effectsModule
      ? createTickerClock(tick, effectsModule.motionTicker)
      : createAnimationClock(tick);
  } catch (error) {
    if (signal.aborted) return;
    scene?.dispose();
    scene = undefined;
    throw error;
  }
  const createScroll = () => {
    if (!policy.smooth || smoothScroll || !scrollFactory) return;
    smoothScroll = scrollFactory(() => effects?.updateScroll());
    html.dataset.smoothScroll = "active";
  };
  function destroyScroll() {
    smoothScroll?.destroy();
    smoothScroll = undefined;
    delete html.dataset.smoothScroll;
  }
  function tick(seconds: number) {
    if (!active || disposed) return;
    smoothScroll?.raf(seconds);
    effects?.frame();
    if (sceneAllowed()) scene?.render(seconds);
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
      clock?.start();
    } else {
      effects?.pause();
      destroyScroll();
      clock?.stop();
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
