import { articleOverview, parseCodeCaption } from "../lib/editorial-reader";
import type { DocumentDetail } from "../lib/documents";

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) {
  const value = document.createElement(tag);
  value.textContent = text;
  value.className = className;
  return value;
}

/** Metadata stays outside article text so saved quotation anchors remain stable. */
export function initEditorialReader(data: DocumentDetail, body: HTMLElement) {
  const overview = document.getElementById("article-overview");
  const headings = articleOverview(data.headings || []);
  if (overview) {
    overview.hidden = headings.length === 0;
    overview.replaceChildren(node("span", "READING MAP / 本篇线索", "eyebrow"));
    const list = node("ol");
    for (const heading of headings) {
      const row = node("li");
      const link = node("a", heading.text);
      link.href = `#${heading.slug}`;
      row.append(link);
      list.append(row);
    }
    overview.append(list);
  }
  body.querySelectorAll<HTMLElement>(".code-container").forEach(enhanceCode);
}

function enhanceCode(container: HTMLElement) {
  if (container.dataset.editorialReady) return;
  const pre = container.querySelector("pre");
  const code = pre?.querySelector("code");
  if (!pre || !code) return;
  container.dataset.editorialReady = "true";
  // Every ordinary code block must be keyboard scrollable, even when the
  // optional filename/line metadata is absent or deliberately rejected.
  pre.tabIndex = 0;
  pre.setAttribute("role", "region");
  pre.setAttribute(
    "aria-label",
    `${(pre.dataset.language || "CODE").toUpperCase()} 代码，可横向滚动`,
  );
  const source = code.textContent || "";
  const lines = source.replace(/\n$/, "").split("\n").length;
  const previous = container.previousElementSibling;
  const caption =
    previous?.tagName === "P"
      ? parseCodeCaption(previous.textContent || "", lines)
      : null;
  if (!caption) return;
  container.classList.add("editorial-code");
  const label = container.querySelector(".code-language");
  if (label) label.textContent = caption.filename;
  pre.tabIndex = 0;
  pre.setAttribute("role", "region");
  pre.setAttribute(
    "aria-label",
    `${caption.filename} 代码，可横向滚动${caption.highlights.length ? `；重点行 ${caption.highlights.join("、")}` : ""}`,
  );
  // CSS-generated counters never enter copy text or annotation projections.
  const gutter = node("span", "", "code-line-gutter");
  gutter.setAttribute("aria-hidden", "true");
  for (let index = 1; index <= lines; index++) {
    const marker = node("span");
    marker.dataset.lineNumber = String(index);
    marker.className = caption.highlights.includes(index)
      ? "is-emphasized"
      : "";
    gutter.append(marker);
  }
  pre.prepend(gutter);
  if (caption.highlights.length) {
    const note = node(
      "p",
      `重点阅读第 ${caption.highlights.join("、")} 行。`,
      "code-reading-note",
    );
    note.setAttribute("aria-hidden", "true");
    container.append(note);
  }
  enhanceOutput(container);
}

function enhanceOutput(container: HTMLElement) {
  const outputLabel = container.nextElementSibling;
  const output = outputLabel?.nextElementSibling;
  if (
    outputLabel?.tagName !== "P" ||
    outputLabel.textContent?.trim() !== "运行输出：" ||
    !output?.classList.contains("code-container")
  )
    return;
  // Both source and output remain present; a single keyboard switch only collapses output.
  const control = node("button", "收起运行输出", "code-output-toggle");
  control.type = "button";
  control.setAttribute("aria-expanded", "true");
  const setExpanded = (expanded: boolean) => {
    // Keep the article's text projection stable for saved quote contexts.
    // CSS display:none hides it visually and from the accessibility tree, while
    // annotation projection deliberately continues to include the source text.
    output.toggleAttribute("data-output-collapsed", !expanded);
    control.setAttribute("aria-expanded", String(expanded));
    control.textContent = expanded ? "收起运行输出" : "显示运行输出";
  };
  control.addEventListener("click", () => {
    setExpanded(control.getAttribute("aria-expanded") !== "true");
  });
  output.addEventListener("asher:reveal-output", () => setExpanded(true));
  container.append(control);
}
