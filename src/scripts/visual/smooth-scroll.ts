import Lenis from "lenis";
import "lenis/dist/lenis.css";

/** Lenis is isolated in this optional chunk so coarse pointers never fetch it. */
export function mountSmoothScroll(onScroll: () => void) {
  const lenis = new Lenis({
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
  lenis.on("scroll", onScroll);
  return {
    raf(seconds: number) {
      lenis.raf(seconds * 1000);
    },
    destroy() {
      lenis.destroy();
    },
  };
}
