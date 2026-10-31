import { parseExplorer } from "../../lib/explorers";

let observer: IntersectionObserver | undefined;
const pending = new Map<HTMLElement, () => void>();
let moduleTask: Promise<typeof import("./index")> | undefined;
function load() {
  moduleTask ||= import("./index").catch((error) => {
    moduleTask = undefined;
    throw error;
  });
  return moduleTask;
}
export function scheduleExplorers(root: HTMLElement) {
  pending.forEach((_, figure) => {
    if (!figure.isConnected) {
      observer?.unobserve(figure);
      pending.delete(figure);
    }
  });
  let count = 0;
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    const pre = code.parentElement!;
    const language =
      pre.dataset.language ||
      /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1];
    if (language !== "explore" || code.closest(".content-widget")) return;
    const figure = document.createElement("figure");
    figure.className = "content-widget explore-widget";
    figure.setAttribute("aria-label", "交互教学演示");
    const caption = document.createElement("figcaption");
    const badge = document.createElement("span");
    badge.className = "explore-eyebrow";
    badge.textContent = "EXPLORE / 用一次实验理解";
    const title = document.createElement("strong");
    title.textContent = "交互教学";
    caption.append(badge, title);
    const target = document.createElement("div");
    target.className = "explore-body";
    const source = document.createElement("details");
    source.className = "widget-source";
    const summary = document.createElement("summary");
    summary.textContent = "查看原始教学定义";
    source.append(summary);
    pre.replaceWith(figure);
    source.append(pre);
    figure.append(caption, target, source);
    const failure = (message: string) => {
      const text = document.createElement("p");
      text.className = "widget-error";
      text.setAttribute("role", "status");
      text.textContent = message;
      target.replaceChildren(text);
      source.open = true;
    };
    let spec;
    try {
      if (++count > 3)
        throw new Error("每篇最多增强 3 个教学演示，其余保留原文。");
      spec = parseExplorer(code.textContent || "");
    } catch (error) {
      failure(error instanceof Error ? error.message : "定义无效。");
      return;
    }
    title.textContent = spec.title;
    const specification = spec;
    const render = () => {
      target.textContent = "正在准备本地教学模型…";
      void load()
        .then((module) => {
          if (figure.isConnected)
            module.mountExplorer(figure, target, specification);
        })
        .catch(() => {
          failure(
            "教学组件暂时无法加载，原始定义仍保留。正文与代码可继续阅读。",
          );
          const retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = "重试加载教学组件";
          retry.addEventListener("click", render);
          target.append(retry);
        });
    };
    target.textContent = "此处有一个交互教学模型，接近阅读位置时从本站加载。";
    if (typeof IntersectionObserver === "undefined") {
      render();
      return;
    }
    observer ||= new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const figure = entry.target as HTMLElement,
            render = pending.get(figure);
          pending.delete(figure);
          observer?.unobserve(figure);
          render?.();
        }),
      { rootMargin: "250px" },
    );
    pending.set(figure, render);
    observer.observe(figure);
  });
}
