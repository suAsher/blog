import { requestJSON } from "../../lib/documents";
import {
  applyWikiCompletion,
  wikiCompletionRange,
  type WikiCompletionRange,
} from "../../lib/wikilinks";
import { slashCommand, writingCommands } from "../../lib/writing-tools";

interface LinkTarget {
  id: string;
  title: string;
  status: "draft" | "published";
}

interface LinkTargetsResponse {
  documents: LinkTarget[];
  total: number;
  truncated: boolean;
}

const DEBOUNCE_MS = 180;

function optionId(id: string): string {
  return `wiki-target-${id}`;
}

export function setupWikiLinkCompletion(
  source: HTMLTextAreaElement,
  listbox: HTMLElement,
  changed: () => void,
  currentId: () => string,
): { close: () => void } {
  let range: WikiCompletionRange | null = null;
  let targets: LinkTarget[] = [];
  let active = -1;
  let version = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const close = () => {
    clearTimeout(timer);
    range = null;
    targets = [];
    active = -1;
    listbox.hidden = true;
    listbox.replaceChildren();
    source.removeAttribute("aria-activedescendant");
    source.setAttribute("aria-expanded", "false");
  };

  const select = (target: LinkTarget) => {
    if (!range) return;
    const result = applyWikiCompletion(source.value, range, target);
    source.value = result.value;
    source.setSelectionRange(result.cursor, result.cursor);
    close();
    source.focus();
    changed();
  };

  const syncActive = (next: number) => {
    const options = [...listbox.querySelectorAll<HTMLElement>("[role=option]")];
    if (!options.length) return;
    active = (next + options.length) % options.length;
    options.forEach((option, index) => {
      const selected = index === active;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("is-active", selected);
    });
    source.setAttribute("aria-activedescendant", options[active].id);
    options[active].scrollIntoView({ block: "nearest" });
  };

  const render = (documents: LinkTarget[]) => {
    targets = documents.filter((target) => target.id !== currentId());
    active = -1;
    listbox.replaceChildren();
    for (const target of targets) {
      const option = document.createElement("button");
      option.type = "button";
      option.id = optionId(target.id);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const title = document.createElement("span");
      title.textContent = target.title;
      const status = document.createElement("small");
      status.textContent = target.status === "draft" ? "草稿" : "已发布";
      option.append(title, status);
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => select(target));
      listbox.append(option);
    }
    if (!targets.length) {
      const empty = document.createElement("p");
      empty.textContent = "没有匹配的文档，继续输入会保留为待连接标题。";
      listbox.append(empty);
    }
    listbox.hidden = false;
    source.setAttribute("aria-expanded", "true");
  };

  const update = () => {
    const next = wikiCompletionRange(
      source.value,
      source.selectionStart,
      source.selectionEnd,
    );
    if (!next) {
      close();
      return;
    }
    range = next;
    const requestVersion = ++version;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: next.query,
          view: "working",
          limit: "20",
        });
        const result = await requestJSON<LinkTargetsResponse>(
          `/api/link-targets?${params}`,
        );
        if (requestVersion === version && range) render(result.documents);
      } catch {
        if (requestVersion !== version || !range) return;
        listbox.replaceChildren();
        const message = document.createElement("p");
        message.textContent = "暂时无法读取建议；正文仍可继续编辑。";
        listbox.append(message);
        listbox.hidden = false;
        source.setAttribute("aria-expanded", "true");
      }
    }, DEBOUNCE_MS);
  };

  source.setAttribute("role", "combobox");
  source.setAttribute("aria-autocomplete", "list");
  source.setAttribute("aria-controls", listbox.id);
  source.setAttribute("aria-expanded", "false");
  source.addEventListener("input", (event) => {
    if (!(event as InputEvent).isComposing) update();
  });
  source.addEventListener("click", update);
  source.addEventListener("keydown", (event) => {
    if (event.isComposing || listbox.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown"
        ? active + 1
        : active < 0
          ? targets.length - 1
          : active - 1;
      syncActive(next);
    } else if (event.key === "Enter" && targets[active]) {
      event.preventDefault();
      select(targets[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  source.addEventListener("blur", () => setTimeout(close, 120));
  return { close };
}

export function setupInsertionMenu(options: {
  source: HTMLTextAreaElement;
  menu: HTMLElement;
  toggle: HTMLButtonElement;
  unavailable: () => boolean;
  insert: (id: string) => void;
}): { close: () => void } {
  let range: { start: number; end: number; query: string } | undefined;
  const { source, menu, toggle } = options;
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    range = undefined;
  };
  const show = (query = "") => {
    menu.replaceChildren();
    const matches = writingCommands.filter((command) =>
      `${command.label} ${command.hint}`.toLocaleLowerCase().includes(query),
    );
    for (const command of matches) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      const label = document.createElement("span");
      label.textContent = command.label;
      const hint = document.createElement("small");
      hint.textContent = command.id;
      button.append(label, hint);
      button.addEventListener("click", () => {
        if (range) source.setSelectionRange(range.start, range.end);
        options.insert(command.id);
        close();
      });
      menu.append(button);
    }
    if (!matches.length) {
      const message = document.createElement("p");
      message.textContent = "没有匹配的内容块，继续输入或按 Esc。";
      menu.append(message);
    }
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
  };
  toggle.addEventListener("click", () => {
    if (!menu.hidden) return close();
    range = undefined;
    show();
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  });
  source.addEventListener("input", (event) => {
    if ((event as InputEvent).isComposing || options.unavailable()) return;
    const command = slashCommand(
      source.value,
      source.selectionStart,
      source.selectionEnd,
    );
    if (!command) return close();
    range = command;
    show(command.query);
  });
  source.addEventListener("keydown", (event) => {
    if (menu.hidden || event.isComposing) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key))
      return close();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const buttons = menu.querySelectorAll<HTMLButtonElement>("button");
      buttons[event.key === "ArrowDown" ? 0 : buttons.length - 1]?.focus();
    } else if (event.key === "Enter" && range) {
      const first = menu.querySelector<HTMLButtonElement>("button");
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });
  source.addEventListener("click", close);
  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.isComposing)
      return;
    event.preventDefault();
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
      (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element &&
        !event.target.closest(".insert-menu-anchor") && event.target !== source)
      close();
  });
  return { close };
}
