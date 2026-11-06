import { passageTargetState, passageRecoveryHref } from "../lib/passage-search";
import "../styles/passage-search.css";

export interface PassageNavigation {
  canMove: () => boolean;
  dispose: () => void;
}
/** Observe intent during the network wait; browser restoration is not user intent. */
export function capturePassageNavigation(): PassageNavigation {
  const controller = new AbortController();
  const initialHash = location.hash;
  let moved = false;
  const markMoved = () => {
    moved = true;
  };
  const options = { passive: true, signal: controller.signal };
  window.addEventListener("wheel", markMoved, options);
  window.addEventListener("touchstart", markMoved, options);
  window.addEventListener("pointerdown", markMoved, options);
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        [
          "ArrowDown",
          "ArrowUp",
          "PageDown",
          "PageUp",
          "Home",
          "End",
          " ",
          "Tab",
        ].includes(event.key)
      )
        moved = true;
    },
    { signal: controller.signal },
  );
  return {
    canMove: () => !moved && location.hash === initialHash,
    dispose: () => controller.abort(),
  };
}
let disposePrevious = () => {};
export function initPassageTarget(
  body: HTMLElement,
  revision?: string,
  navigation = capturePassageNavigation(),
) {
  disposePrevious();
  const hash = location.hash;
  const anchor = document.getElementById(hash.slice(1));
  const found = anchor instanceof HTMLElement && body.contains(anchor);
  const requested = new URLSearchParams(location.search).get("passageRevision");
  const state = passageTargetState(hash, requested, revision, found);
  if (state === "ignore") {
    navigation.dispose();
    return;
  }
  const controller = new AbortController();
  const status = document.createElement("aside");
  status.id = "passage-target-status";
  status.className = "passage-target-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  const messages = {
    ready: "已定位到搜索命中的段落。",
    updated: "正文已更新；原段落仍然存在，已为你定位。",
    unverified: "已找到原段落；当前无法核验发布版本。",
    missing: "当前已发布正文中未找到原段落，它可能已被修改或移除。请重新搜索。",
  };
  message.textContent = messages[state];
  status.append(message);
  const back = document.createElement("a");
  back.href = passageRecoveryHref(hash, location.search)!;
  back.textContent = "重新搜索";
  status.append(back);
  body.before(status);
  let target: HTMLElement | undefined;
  let addedTabIndex = false;
  if (found && anchor instanceof HTMLElement) {
    target = anchor.matches(".passage-anchor")
      ? (anchor.nextElementSibling as HTMLElement | null) ||
        anchor.parentElement ||
        undefined
      : anchor;
    if (target) {
      const destination = target;
      const move = () => {
        for (
          let ancestor: HTMLElement | null = destination;
          ancestor && ancestor !== body;
          ancestor = ancestor.parentElement
        ) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
          if (ancestor.hasAttribute("data-output-collapsed"))
            ancestor.dispatchEvent(new Event("asher:reveal-output"));
        }
        destination.classList.add("passage-target");
        if (!destination.hasAttribute("tabindex")) {
          destination.tabIndex = -1;
          addedTabIndex = true;
        }
        destination.focus({ preventScroll: true });
        // A single instant move cannot compete with a later user scroll or motion preference.
        destination.scrollIntoView({ block: "center", behavior: "instant" });
      };
      const locate = document.createElement("button");
      locate.type = "button";
      locate.className = "quiet-link";
      locate.textContent = "定位到段落";
      locate.addEventListener("click", move, { signal: controller.signal });
      status.append(locate);
      const frame = requestAnimationFrame(() => {
        if (navigation.canMove()) move();
        else
          message.textContent =
            state === "updated"
              ? "正文已更新；原段落仍然存在。你可以点击“定位到段落”继续。"
              : "已找到搜索命中的段落。你可以点击“定位到段落”继续。";
        navigation.dispose();
      });
      controller.signal.addEventListener(
        "abort",
        () => cancelAnimationFrame(frame),
        { once: true },
      );
    }
  } else navigation.dispose();
  disposePrevious = () => {
    controller.abort();
    navigation.dispose();
    status.remove();
    target?.classList.remove("passage-target");
    if (addedTabIndex) target?.removeAttribute("tabindex");
  };
  window.addEventListener("pagehide", disposePrevious, {
    once: true,
    signal: controller.signal,
  });
}

/** Keep query recovery available even when the entire publication has disappeared. */
export function initPassageRecovery(container: HTMLElement) {
  document.getElementById("passage-recovery-link")?.remove();
  const href = passageRecoveryHref(location.hash, location.search);
  if (!href) return;
  const link = document.createElement("a");
  link.id = "passage-recovery-link";
  link.className = "button";
  link.href = href;
  link.textContent = "用原关键词重新搜索";
  (container.querySelector(".empty-writing-actions") || container).append(link);
}
