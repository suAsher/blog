// Pointer work is event-driven: one pending frame, never an idle rendering loop.
const preference = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
let pointerFrame = 0;
let previousCard: HTMLElement | undefined;
let revealObserver: IntersectionObserver | undefined;
const pending = new Set<HTMLElement>();

function syncMotion() {
  const paused = preference.matches || document.hidden;
  document.documentElement.dataset.motion = paused ? 'paused' : 'active';
  if (paused) {
    cancelAnimationFrame(pointerFrame); pointerFrame = 0;
    document.querySelector<HTMLElement>('.orbit-art')?.style.removeProperty('--orbit-x');
    document.querySelector<HTMLElement>('.orbit-art')?.style.removeProperty('--orbit-y');
    previousCard?.classList.remove('spotlight-active');
    pending.forEach(node => { node.classList.remove('reveal-pending'); revealObserver?.unobserve(node); }); pending.clear();
  }
}
syncMotion();
preference.addEventListener('change', syncMotion);
document.addEventListener('visibilitychange', syncMotion);

if (!document.body.classList.contains('article-page')) {
  if ('IntersectionObserver' in window) {
    revealObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.remove('reveal-pending'); pending.delete(entry.target as HTMLElement); revealObserver?.unobserve(entry.target); } });
    }, { rootMargin: '0px 0px 40px 0px', threshold: 0.03 });
  }
  function prepare(scope: ParentNode) {
    scope.querySelectorAll<HTMLElement>('.article-card,.featured-card,.continue-card,.lab-invitation').forEach(node => {
      if (node.dataset.motionPrepared) return;
      node.dataset.motionPrepared = 'true'; node.classList.add('spotlight-card');
      if (!preference.matches && !document.hidden && revealObserver && node.getBoundingClientRect().top > innerHeight * 0.9) {
        node.classList.add('reveal-pending'); pending.add(node); revealObserver.observe(node);
      }
    });
  }
  prepare(document);
  // Watch only card containers, never the editor or a potentially long article.
  document.querySelectorAll('#home-featured,#home-latest,#article-results,#library-results').forEach(content => {
    new MutationObserver(() => prepare(content)).observe(content, { childList: true });
  });

  document.addEventListener('pointermove', event => {
    if (!finePointer.matches || preference.matches || document.hidden || pointerFrame) return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>('.spotlight-card');
    const orbit = target?.closest<HTMLElement>('.orbit-art');
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      if (previousCard !== card) previousCard?.classList.remove('spotlight-active');
      if (card) {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--spot-x', `${Math.round(event.clientX - rect.left)}px`);
        card.style.setProperty('--spot-y', `${Math.round(event.clientY - rect.top)}px`);
        card.classList.add('spotlight-active');
      }
      previousCard = card || undefined;
      if (orbit) {
        const rect = orbit.getBoundingClientRect();
        orbit.style.setProperty('--orbit-x', `${((event.clientX - rect.left) / rect.width - 0.5) * 16}px`);
        orbit.style.setProperty('--orbit-y', `${((event.clientY - rect.top) / rect.height - 0.5) * 12}px`);
      }
    });
  }, { passive: true });
  document.querySelector<HTMLElement>('.orbit-art')?.addEventListener('pointerleave', event => {
    const orbit = event.currentTarget as HTMLElement;
    orbit.style.removeProperty('--orbit-x'); orbit.style.removeProperty('--orbit-y');
  });
  document.addEventListener('pointerleave', () => previousCard?.classList.remove('spotlight-active'));
}
