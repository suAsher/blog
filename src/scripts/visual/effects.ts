import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Plugin import can auto-register global loops before a surface is mounted.
// Keep the engine dormant until this surface explicitly resumes it.
gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.disable(false);
gsap.ticker.sleep();

export const motionTicker = gsap.ticker;

const cardSelector =
  ".article-card,.featured-card,.continue-card,.lab-invitation";

/** Delegation also covers the real article cards rendered after the content request. */
export function mountEffects(signal: AbortSignal) {
  ScrollTrigger.enable();
  const pending = new Set<HTMLElement>();
  const observed = new WeakSet<HTMLElement>();
  const timelines = new Set<gsap.core.Tween>();
  let previousCard: HTMLElement | null = null;
  let pointer: PointerEvent | undefined;
  let enabled = true;
  const cursor = document.createElement("div");
  cursor.className = "knowledge-cursor";
  cursor.setAttribute("aria-hidden", "true");
  document.body.append(cursor);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const node = entry.target as HTMLElement;
        pending.delete(node);
        observer.unobserve(node);
        if (!enabled) {
          node.classList.remove("reveal-pending");
          continue;
        }
        node.classList.remove("reveal-pending");
        const tween = gsap.fromTo(
          node,
          { opacity: 0.55 },
          {
            opacity: 1,
            duration: 0.7,
            ease: "power3.out",
            clearProps: "opacity",
            onComplete: () => timelines.delete(tween),
          },
        );
        timelines.add(tween);
      }
    },
    { threshold: 0.04, rootMargin: "0px 0px 12px" },
  );
  const prepare = (scope: ParentNode) => {
    scope.querySelectorAll<HTMLElement>(cardSelector).forEach((card) => {
      if (observed.has(card)) return;
      observed.add(card);
      card.classList.add("spotlight-card");
      if (enabled && card.getBoundingClientRect().top > innerHeight) {
        card.classList.add("reveal-pending");
        pending.add(card);
        observer.observe(card);
      }
    });
  };
  prepare(document);
  const mutation = new MutationObserver(() => prepare(document));
  // Observe the bounded result grids, never the article body or editor.
  document
    .querySelectorAll(
      "#home-featured,#home-latest,#article-results,#library-results",
    )
    .forEach((node) =>
      mutation.observe(node, { childList: true, subtree: true }),
    );
  const resetCard = () => {
    previousCard?.classList.remove("spotlight-active");
    previousCard?.style.removeProperty("--card-axis-x");
    previousCard?.style.removeProperty("--card-axis-y");
    previousCard?.style.removeProperty("--card-angle");
    previousCard = null;
  };
  document.addEventListener(
    "pointermove",
    (event) => {
      if (enabled && event.pointerType === "mouse") pointer = event;
    },
    { passive: true, signal },
  );
  document.addEventListener(
    "pointerleave",
    () => {
      pointer = undefined;
      resetCard();
      cursor.classList.remove("is-visible");
    },
    { signal },
  );
  document.addEventListener(
    "pointerdown",
    () => cursor.classList.remove("is-visible"),
    { signal },
  );
  const title = document.querySelector<HTMLElement>(".hero-copy h1");
  const originalTitle = title?.innerHTML;
  const originalLabel = title?.getAttribute("aria-label");
  if (title && !title.querySelector("a,button")) {
    title.setAttribute(
      "aria-label",
      title.innerText.replace(/\s+/g, " ").trim(),
    );
    const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    for (const text of texts) {
      const fragment = document.createDocumentFragment();
      for (const character of text.textContent || "") {
        const letter = document.createElement("span");
        letter.className = "hero-letter";
        letter.setAttribute("aria-hidden", "true");
        letter.textContent = character;
        fragment.append(letter);
      }
      text.replaceWith(fragment);
    }
    const letters = title.querySelectorAll(".hero-letter");
    // The heading is already painted; animation never waits to reveal its content.
    const tween = gsap.fromTo(
      letters,
      { y: 6, opacity: 0.72 },
      {
        y: 0,
        opacity: 1,
        stagger: 0.022,
        duration: 0.9,
        ease: "power3.out",
        clearProps: "all",
      },
    );
    timelines.add(tween);
  }
  const hero = document.querySelector<HTMLElement>("[data-hero-art]");
  const parallax = hero
    ? gsap.to(hero, {
        "--hero-scroll": "1",
        ease: "none",
        scrollTrigger: {
          trigger: ".hero",
          start: "top top",
          end: "bottom top",
          scrub: 0.6,
        },
      })
    : undefined;
  return {
    updateScroll() {
      ScrollTrigger.update();
    },
    frame() {
      if (!enabled || !pointer) return;
      const event = pointer;
      pointer = undefined;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("dialog,[contenteditable],input,textarea,select")) {
        resetCard();
        cursor.classList.remove("is-visible");
        return;
      }
      cursor.style.setProperty("--cursor-x", `${event.clientX}px`);
      cursor.style.setProperty("--cursor-y", `${event.clientY}px`);
      cursor.classList.add("is-visible");
      cursor.classList.toggle("is-link", !!target?.closest("a,button"));
      const card = target?.closest<HTMLElement>(cardSelector) ?? null;
      if (card !== previousCard) resetCard();
      if (!card) return;
      const rect = card.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      card.style.setProperty("--spot-x", `${x}px`);
      card.style.setProperty("--spot-y", `${y}px`);
      card.style.setProperty("--card-axis-x", String(-(y / rect.height - 0.5)));
      card.style.setProperty("--card-axis-y", String(x / rect.width - 0.5));
      card.style.setProperty("--card-angle", "2deg");
      card.classList.add("spotlight-active");
      previousCard = card;
    },
    pause() {
      enabled = false;
      pointer = undefined;
      resetCard();
      cursor.classList.remove("is-visible");
      timelines.forEach((tween) => tween.pause());
      parallax?.pause();
      parallax?.scrollTrigger?.disable(false);
      ScrollTrigger.disable(false);
      pending.forEach((node) => node.classList.remove("reveal-pending"));
    },
    resume() {
      ScrollTrigger.enable();
      enabled = true;
      timelines.forEach((tween) => tween.resume());
      parallax?.scrollTrigger?.enable(false);
      parallax?.resume();
    },
    dispose() {
      observer.disconnect();
      mutation.disconnect();
      cursor.remove();
      resetCard();
      pending.forEach((node) => node.classList.remove("reveal-pending"));
      timelines.forEach((tween) => {
        tween.progress(1);
        tween.kill();
      });
      parallax?.scrollTrigger?.kill();
      parallax?.kill();
      ScrollTrigger.disable(false);
      hero?.style.removeProperty("--hero-scroll");
      if (title && originalTitle !== undefined) {
        title.innerHTML = originalTitle;
        if (originalLabel === null) title.removeAttribute("aria-label");
        else if (originalLabel) title.setAttribute("aria-label", originalLabel);
      }
      gsap.ticker.sleep();
    },
  };
}
