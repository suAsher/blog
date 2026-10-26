import { requestJSON, type DocumentDetail } from "../../lib/documents";

interface LinkTarget {
  id: string;
  title: string;
  status: "draft" | "published";
  unavailable?: boolean;
}

interface LinkTargetsResponse {
  documents: LinkTarget[];
}

export class RelatedDocumentSelector {
  private selected: LinkTarget[] = [];
  private selectedIds: string[] = [];
  private matches: LinkTarget[] = [];
  private active = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hydrationVersion = 0;
  private searchVersion = 0;
  private locked = false;

  constructor(
    private input: HTMLInputElement,
    private listbox: HTMLElement,
    private chips: HTMLElement,
    private changed: () => void,
    private currentId: () => string,
  ) {
    input.addEventListener("input", () => this.schedule());
    input.addEventListener("keydown", (event) => this.keydown(event));
    input.addEventListener("blur", () => setTimeout(() => this.close(), 120));
  }

  get values(): string[] {
    return [...this.selectedIds];
  }

  async setValues(ids: readonly string[]): Promise<void> {
    const version = ++this.hydrationVersion;
    this.selectedIds = [...new Set(ids)].slice(0, 32);
    this.selected = this.selectedIds.map((id) => ({
      id,
      title: "正在读取相关文档…",
      status: "draft",
      unavailable: true,
    }));
    this.renderChips();
    const documents = await Promise.all(
      this.selectedIds.map(async (id) => {
        try {
          const document = await requestJSON<DocumentDetail>(
            `/api/documents/${encodeURIComponent(id)}`,
          );
          if (document.status === "trash") throw new Error("unavailable");
          return {
            id: document.id,
            title: document.title,
            status: document.status,
          } as LinkTarget;
        } catch {
          return {
            id,
            title: "暂时无法读取的相关文档",
            status: "draft",
            unavailable: true,
          } as LinkTarget;
        }
      }),
    );
    if (version !== this.hydrationVersion) return;
    this.selected = documents;
    this.renderChips();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.input.disabled = locked;
    this.chips.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = locked;
    });
    if (locked) this.close();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.search(), 180);
  }

  private async search(): Promise<void> {
    if (this.locked) return;
    const version = ++this.searchVersion;
    if (this.selectedIds.length >= 32) {
      this.matches = [];
      this.listbox.replaceChildren();
      const message = document.createElement("p");
      message.textContent = "每篇文档最多选择 32 篇相关文档。";
      this.listbox.append(message);
      this.listbox.hidden = false;
      this.input.setAttribute("aria-expanded", "true");
      return;
    }
    try {
      const result = await requestJSON<LinkTargetsResponse>(
        `/api/link-targets?${new URLSearchParams({ q: this.input.value.trim(), view: "working", limit: "20" })}`,
      );
      if (version !== this.searchVersion) return;
      const selected = new Set(this.values);
      this.matches = result.documents.filter(
        (item) => item.id !== this.currentId() && !selected.has(item.id),
      );
      this.renderMatches();
    } catch {
      if (version !== this.searchVersion) return;
      this.matches = [];
      this.listbox.replaceChildren();
      const message = document.createElement("p");
      message.textContent = "暂时无法搜索相关文档。";
      this.listbox.append(message);
      this.listbox.hidden = false;
    }
  }

  private renderMatches(): void {
    this.listbox.replaceChildren();
    this.matches.forEach((target, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.id = `related-option-${target.id}`;
      option.textContent = target.title;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => this.add(target));
      this.listbox.append(option);
      if (index === 0) this.setActive(0);
    });
    if (!this.matches.length) {
      const empty = document.createElement("p");
      empty.textContent = "没有更多匹配文档。";
      this.listbox.append(empty);
    }
    this.listbox.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
  }

  private renderChips(): void {
    this.chips.replaceChildren();
    this.selected.forEach((target) => {
      const chip = document.createElement("span");
      chip.textContent = target.title;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除相关文档：${target.title}`);
      remove.textContent = "×";
      remove.disabled = this.locked;
      remove.addEventListener("click", () => this.remove(target.id));
      chip.append(remove);
      this.chips.append(chip);
    });
  }

  private add(target: LinkTarget): void {
    this.selected = [...this.selected, target];
    this.selectedIds = [...this.selectedIds, target.id];
    this.input.value = "";
    this.close();
    this.renderChips();
    this.changed();
  }

  private remove(id: string): void {
    this.selected = this.selected.filter((item) => item.id !== id);
    this.selectedIds = this.selectedIds.filter((selectedId) => selectedId !== id);
    this.renderChips();
    this.changed();
  }

  private setActive(index: number): void {
    const options = [...this.listbox.querySelectorAll<HTMLElement>("[role=option]")];
    if (!options.length) return;
    this.active = (index + options.length) % options.length;
    options.forEach((option, optionIndex) =>
      option.setAttribute("aria-selected", String(optionIndex === this.active)),
    );
    this.input.setAttribute("aria-activedescendant", options[this.active].id);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || this.listbox.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.setActive(this.active + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter" && this.matches[this.active]) {
      event.preventDefault();
      this.add(this.matches[this.active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  private close(): void {
    this.listbox.hidden = true;
    this.listbox.replaceChildren();
    this.matches = [];
    this.active = -1;
    this.input.setAttribute("aria-expanded", "false");
    this.input.removeAttribute("aria-activedescendant");
  }
}
