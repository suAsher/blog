export function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
export function button(text: string, action: () => void) {
  const result = node("button", text);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
}
let sequence = 0;
const activePlayers = new Map<
  HTMLElement,
  { stop: () => void; dispose: () => void }
>();
let removalObserver: MutationObserver | undefined;
function registerPlayer(
  figure: HTMLElement,
  stop: () => void,
  dispose: () => void,
) {
  if (!removalObserver) {
    removalObserver = new MutationObserver(() => {
      activePlayers.forEach((player, target) => {
        if (target.isConnected) return;
        player.dispose();
        activePlayers.delete(target);
      });
    });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("pagehide", () =>
      activePlayers.forEach((player) => player.stop()),
    );
  }
  activePlayers.set(figure, { stop, dispose });
}
export function slider(
  label: string,
  min: number,
  max: number,
  value: number,
  change: (value: number) => void,
) {
  const wrapper = node("div", "", "explore-input");
  const id = `explore-input-${++sequence}`;
  const title = node("label", label);
  title.htmlFor = id;
  const output = node("output", String(value));
  const input = node("input");
  input.id = id;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener("input", () => {
    output.value = input.value;
    change(Number(input.value));
  });
  wrapper.append(title, output, input);
  return { wrapper, input, output };
}
/** A step player has no background loop; it stops when hidden or out of view. */
export function player(
  figure: HTMLElement,
  steps: () => number,
  render: (step: number) => void,
) {
  const controls = node("div", "", "explore-player");
  let at = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const status = node("span");
  status.setAttribute("role", "status");
  const play = button("播放步骤", () => {
    if (timer) {
      stop();
      return;
    }
    if (at >= steps() - 1) at = 0;
    timer = setInterval(() => {
      if (!figure.isConnected || document.hidden) {
        stop();
        return;
      }
      at = Math.min(at + 1, steps() - 1);
      update();
      if (at >= steps() - 1) stop();
    }, 1000);
    play.textContent = "暂停";
  });
  const next = button("下一步", () => {
    stop();
    at = Math.min(at + 1, steps() - 1);
    update();
  });
  const reset = button("重置步骤", () => {
    stop();
    at = 0;
    update();
  });
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    play.textContent = "播放步骤";
  };
  const update = () => {
    next.disabled = at >= steps() - 1;
    status.textContent = `${at + 1} / ${steps()} 步`;
    render(at);
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const preference = () => {
    if (reduced.matches) stop();
    play.disabled = reduced.matches;
    play.title = reduced.matches ? "减少动态效果时请使用下一步" : "";
  };
  preference();
  reduced.addEventListener("change", preference);
  const visibility = () => {
    if (document.hidden) stop();
  };
  document.addEventListener("visibilitychange", visibility);
  const observer =
    typeof IntersectionObserver === "undefined"
      ? undefined
      : new IntersectionObserver((entries) => {
          if (!entries[0]?.isIntersecting) stop();
        });
  observer?.observe(figure);
  // Release preview listeners as soon as their DOM is replaced.
  const dispose = () => {
    stop();
    observer?.disconnect();
    reduced.removeEventListener("change", preference);
    document.removeEventListener("visibilitychange", visibility);
  };
  registerPlayer(figure, stop, dispose);
  controls.append(play, next, reset, status);
  update();
  return {
    controls,
    reset: () => {
      stop();
      at = 0;
      update();
    },
  };
}
