import {
  commandMatches,
  highlightSegments,
  nextCommandIndex,
} from "../lib/commands";
import { reviewDocuments } from "../lib/daily";
import "./motion";
import {
  articleUrl,
  element,
  getState,
  loadIndex,
  loadLibraryIndex,
  queryPublished,
  patchEntry,
  syncBookmarkButtons,
  toast,
  usingExamples,
} from "./shared";

// A shared name belongs only to the chosen card, never every image in a grid.
// Normal links and full-document navigation remain usable without this effect.
document.addEventListener(
  "click",
  (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>("a[href]")
        : null;
    if (
      !link ||
      link.origin !== location.origin ||
      !/^\/articles\/[^/]+\/$/.test(link.pathname)
    )
      return;
    const card = link.closest(".article-card, .featured-card");
    const image = card?.querySelector<HTMLImageElement>(
      ".card-cover img, .featured-image img",
    );
    if (!image) return;
    document
      .querySelectorAll<HTMLElement>("[data-cover-transition]")
      .forEach((previous) => {
        previous.style.removeProperty("view-transition-name");
        previous.removeAttribute("data-cover-transition");
      });
    image.dataset.coverTransition = "";
    image.style.viewTransitionName = "article-cover";
  },
  { capture: true },
);

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  document
    .querySelectorAll<HTMLElement>("[data-cover-transition]")
    .forEach((image) => {
      image.style.removeProperty("view-transition-name");
      image.removeAttribute("data-cover-transition");
    });
});

const themeButton = document.querySelector<HTMLButtonElement>(
  "[data-theme-toggle]",
);
function updateThemeLabel() {
  themeButton?.setAttribute(
    "aria-label",
    `切换到${document.documentElement.dataset.theme === "dark" ? "浅" : "深"}色主题`,
  );
}
updateThemeLabel();
themeButton?.addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("asher-theme", next);
  } catch {
    toast("主题已切换，此浏览器未允许保存偏好。");
  }
  updateThemeLabel();
});

const logoutButton = document.querySelector<HTMLButtonElement>("[data-logout]");
logoutButton?.addEventListener("click", async () => {
  if (logoutButton.disabled) return;
  logoutButton.disabled = true;
  try {
    const response = await fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Logout unavailable");
    location.replace("/login/?reason=logout");
  } catch {
    toast("暂时无法退出，请检查连接后重试。");
    logoutButton.disabled = false;
  }
});

const dialog = document.querySelector<HTMLDialogElement>("#search-dialog");
const query = document.querySelector<HTMLInputElement>("#quick-search");
const results = document.querySelector<HTMLElement>("#quick-results");
const searchStatus = document.getElementById("quick-search-status");
let searchVersion = 0;
let quickTimer: ReturnType<typeof setTimeout>;
let quickRequest: AbortController | undefined;
let selectedIndex = -1;
let renderedTerm = "";
let resumeArticle: { id: string; title: string } | undefined;
interface Command {
  title: string;
  detail: string;
  aliases: string[];
  href?: string;
  action?: () => void;
}
function commands(): Command[] {
  const actions: Command[] = [
    {
      title: "随手记",
      detail: "快速保存一个想法为草稿",
      aliases: ["note", "capture", "笔记", "记录"],
      action: () =>
        document.dispatchEvent(new CustomEvent("quick-capture:open")),
    },
    {
      title: "新建文档",
      detail: "从一个新想法开始",
      aliases: ["new", "write", "写作"],
      href: "/manage/?new=1",
    },
    {
      title: "随机回顾",
      detail: "重新阅读一篇已发布文章",
      aliases: ["random", "review", "回顾", "旧文"],
      action: () => void openRandomArticle(),
    },
    {
      title: "导入文档",
      detail: "带入 Markdown、TXT 与配图",
      aliases: ["import", "upload", "上传"],
      href: "/manage/?import=1",
    },
    {
      title: "我的书架",
      detail: "查看阅读与收藏",
      aliases: ["library", "书架"],
      href: "/library/",
    },
    {
      title: "全部文章",
      detail: "浏览已发布内容",
      aliases: ["articles", "浏览"],
      href: "/articles/",
    },
    {
      title: "首页",
      detail: "返回今日与最新内容",
      aliases: ["home", "today", "今天"],
      href: "/",
    },
    {
      title: "内容实验室",
      detail: "试用交互图表、流程图和内容模板",
      aliases: ["lab", "实验", "模板"],
      href: "/lab/",
    },
    {
      title: "切换主题",
      detail: "在深色与浅色之间切换",
      aliases: ["theme", "light", "dark"],
      action: () => themeButton?.click(),
    },
  ];
  const entry = resumeArticle && getState()[resumeArticle.id];
  return resumeArticle && entry && entry.progress > 0 && !entry.read
    ? [
        {
          title: "继续阅读",
          detail: resumeArticle.title,
          aliases: ["resume", "continue"],
          href: articleUrl(resumeArticle.id, true),
        },
        ...actions,
      ]
    : actions;
}
async function openRandomArticle() {
  try {
    const articles = reviewDocuments(await loadIndex());
    if (!articles.length) {
      toast("目前没有可回顾的已发布文章。");
      return;
    }
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    location.assign(articleUrl(articles[bytes[0] % articles.length].id));
  } catch {
    toast("暂时无法读取已发布文章，请检查连接后重试。");
  }
}
function row(node: HTMLAnchorElement | HTMLButtonElement) {
  node.dataset.commandRow = "";
  node.id = `command-result-${results?.querySelectorAll("[data-command-row]").length || 0}`;
  return node;
}
function appendHighlighted(parent: HTMLElement, value: string, term: string) {
  highlightSegments(value, term).forEach((segment) =>
    parent.append(
      segment.match
        ? element("mark", "", segment.text)
        : document.createTextNode(segment.text),
    ),
  );
}
function renderActions(term: string) {
  if (!results) return;
  const actions = commands().filter((command) =>
    commandMatches(command.title, command.aliases, term),
  );
  if (actions.length)
    results.append(element("p", "command-section-title", "快速行动"));
  actions.forEach((command) => {
    const entry = row(
      command.href
        ? element("a", "command-action")
        : element("button", "command-action"),
    );
    if (entry instanceof HTMLAnchorElement) entry.href = command.href!;
    else {
      entry.type = "button";
      entry.addEventListener("click", () => {
        dialog?.close();
        command.action?.();
      });
    }
    const icon = element(
      "span",
      "command-symbol",
      command.title === "切换主题"
        ? "◐"
        : command.title === "内容实验室"
          ? "✧"
          : command.title === "导入文档"
            ? "↥"
            : command.title === "继续阅读"
              ? "↗"
              : "+",
    );
    icon.setAttribute("aria-hidden", "true");
    const label = element("span");
    label.append(
      element("strong", "", command.title),
      element("small", "", command.detail),
    );
    const enter = element("kbd", "", "↵");
    enter.setAttribute("aria-hidden", "true");
    entry.append(icon, label, enter);
    results?.append(entry);
  });
  return actions.length;
}
async function quickSearch() {
  if (!results || !query) return;
  const version = ++searchVersion;
  quickRequest?.abort();
  quickRequest = new AbortController();
  selectedIndex = -1;
  const term = query.value.trim();
  renderedTerm = term;
  results.replaceChildren();
  const actionCount = renderActions(term);
  if (!term || term.startsWith(">")) {
    if (!actionCount)
      results.append(
        element(
          "p",
          "search-hint",
          "没有匹配的操作，试试“新建”“导入”或“主题”。",
        ),
      );
    if (searchStatus)
      searchStatus.textContent = term
        ? `${actionCount || 0} 个操作`
        : "搜索全文，或输入 > 执行操作";
    return;
  }
  const loading = element("p", "search-hint", "正在查找…");
  results.append(loading);
  const started = performance.now();
  try {
    const matches = (
      await queryPublished(term, "", "", 0, 7, quickRequest.signal)
    ).documents;
    if (version !== searchVersion) return;
    loading.remove();
    if (searchStatus)
      searchStatus.textContent = `${matches.length}${matches.length === 7 ? "+" : ""} 篇匹配 · ${Math.max(1, Math.round(performance.now() - started))} ms`;
    if (!matches.length)
      results.append(
        element("p", "search-hint", "没有找到相关内容，试试其他关键词。"),
      );
    else results.append(element("p", "command-section-title", "文章全文"));
    matches.forEach((article) => {
      const link = row(element("a", "search-result"));
      (link as HTMLAnchorElement).href = articleUrl(article.id);
      const token = term.split(/\s+/)[0].toLocaleLowerCase();
      const at = article.body.toLocaleLowerCase().indexOf(token);
      const excerpt =
        at >= 0
          ? `…${article.body.slice(Math.max(0, at - 30), at + 90).replace(/[#*`>]/g, "")}…`
          : article.description;
      const title = element("strong");
      appendHighlighted(title, article.title, term);
      const snippet = element("p");
      appendHighlighted(snippet, excerpt, term);
      link.append(
        element("small", "", article.demo ? "示例文章" : "文章"),
        title,
        snippet,
      );
      results?.append(link);
    });
    const all = row(
      element("a", "quiet-link mint", "查看全部搜索结果 →"),
    ) as HTMLAnchorElement;
    all.href = `/articles/?q=${encodeURIComponent(term)}${usingExamples() ? "&examples=1" : ""}`;
    results.append(all);
  } catch {
    if (version === searchVersion) {
      loading.remove();
      results.append(
        element(
          "p",
          "search-hint",
          "搜索索引暂时无法加载，请检查连接后重新输入。",
        ),
      );
      if (searchStatus) searchStatus.textContent = "连接暂时不可用";
    }
  }
}
async function openSearch() {
  resumeArticle = undefined;
  document.querySelector<HTMLDialogElement>("#capture-dialog[open]")?.close();
  if (!dialog?.open) dialog?.showModal();
  query?.focus();
  void quickSearch();
  const state = getState();
  if (Object.values(state).some((entry) => entry.progress > 0 && !entry.read)) {
    const version = searchVersion;
    try {
      const articles = await loadLibraryIndex();
      if (!dialog?.open || version !== searchVersion) return;
      const currentState = getState();
      resumeArticle = articles
        .filter(
          (article) =>
            currentState[article.id]?.progress > 0 &&
            !currentState[article.id]?.read,
        )
        .sort(
          (a, b) => currentState[b.id].updatedAt - currentState[a.id].updatedAt,
        )[0];
      if (dialog?.open && version === searchVersion && !query?.value.trim())
        void quickSearch();
    } catch {
      /* Available commands do not depend on reading history loading. */
    }
  }
}
document
  .querySelector("[data-open-search]")
  ?.addEventListener("click", () => void openSearch());
document
  .querySelector("[data-close-search]")
  ?.addEventListener("click", () => dialog?.close());
query?.addEventListener("input", (event) => {
  searchVersion++;
  quickRequest?.abort();
  clearTimeout(quickTimer);
  if ((event as InputEvent).isComposing) return;
  if (query.value.trim().startsWith(">")) void quickSearch();
  else quickTimer = setTimeout(() => void quickSearch(), 180);
});
query?.addEventListener("compositionend", () => {
  clearTimeout(quickTimer);
  if (query.value.trim().startsWith(">")) void quickSearch();
  else quickTimer = setTimeout(() => void quickSearch(), 180);
});
dialog?.addEventListener("close", () => {
  // The close event is queued. A rapid Cmd+K reopen must keep its new request.
  if (dialog.open) return;
  searchVersion++;
  quickRequest?.abort();
  clearTimeout(quickTimer);
  selectedIndex = -1;
});
dialog?.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
    return;
  }
  if (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    renderedTerm !== query?.value.trim()
  ) {
    clearTimeout(quickTimer);
    void quickSearch();
  }
  const rows = [
    ...(results?.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>(
      "[data-command-row]",
    ) || []),
  ];
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && rows.length) {
    event.preventDefault();
    const focused = rows.findIndex((entry) => entry === document.activeElement);
    selectedIndex = nextCommandIndex(
      focused >= 0 ? focused : selectedIndex,
      rows.length,
      event.key === "ArrowDown" ? 1 : -1,
    );
    rows.forEach((entry, index) =>
      entry.classList.toggle("command-selected", index === selectedIndex),
    );
    rows[selectedIndex].focus({ preventScroll: true });
    rows[selectedIndex].scrollIntoView({ block: "nearest" });
  } else if (
    event.key === "Enter" &&
    selectedIndex >= 0 &&
    rows[selectedIndex] === document.activeElement
  ) {
    event.preventDefault();
    rows[selectedIndex].click();
  }
});
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      dialog.close();
  }
});
document.addEventListener("keydown", (event) => {
  if (
    !event.isComposing &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k"
  ) {
    event.preventDefault();
    void openSearch();
  }
});
document.addEventListener("click", (event) => {
  const target = event.target as Element;
  const button = target.closest<HTMLButtonElement>("[data-bookmark]");
  if (button?.dataset.bookmark) {
    const id = button.dataset.bookmark;
    const bookmarked = !getState()[id]?.bookmarked;
    const saved = patchEntry(id, { bookmarked });
    if (saved) toast(bookmarked ? "已放入我的书架" : "已取消收藏");
  }
});
syncBookmarkButtons();

const continueInvitation = document
  .getElementById("continue-reading")
  ?.cloneNode(true) as HTMLElement | undefined;
async function updateContinueReading() {
  const area = document.getElementById("continue-reading");
  if (!area) return;
  try {
    const state = getState();
    if (
      !Object.values(state).some((entry) => entry.progress > 0 && !entry.read)
    ) {
      if (continueInvitation)
        area.replaceChildren(
          ...[...continueInvitation.childNodes].map((node) =>
            node.cloneNode(true),
          ),
        );
      return;
    }
    const articles = await loadLibraryIndex();
    const article = articles
      .filter((a) => state[a.id]?.progress > 0 && !state[a.id]?.read)
      .sort((a, b) => state[b.id].updatedAt - state[a.id].updatedAt)[0];
    if (!article) {
      if (continueInvitation)
        area.replaceChildren(
          ...[...continueInvitation.childNodes].map((node) =>
            node.cloneNode(true),
          ),
        );
      return;
    }
    const link = element("a", "quiet-link mint", "接着上次读 →");
    link.href = articleUrl(article.id, true);
    area.replaceChildren(
      element("h3", "", article.title),
      element(
        "p",
        "",
        `上次读到 ${Math.round(state[article.id].progress)}%，让思考继续。`,
      ),
      link,
    );
  } catch {
    /* Default reading invitation remains usable when the index is unavailable. */
  }
}
void updateContinueReading();
document.addEventListener("reading:change", updateContinueReading);
