import type { DocumentContent } from "./documents";
export interface QuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}
export interface Annotation {
  id: string;
  documentId: string;
  quote: QuoteSelector;
  body: string;
  color: "mint" | "violet" | "amber";
  version: number;
  createdAt: string;
  updatedAt: string;
}
export type QuoteResolution =
  | { state: "matched"; start: number; end: number }
  | { state: "missing" | "ambiguous" | "stale" };
export const normalizeQuoteText = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();

/** Build UTF-16 boundaries once, retaining full Unicode and whitespace spans. */
function normalizedMap(source: string) {
  const text = normalizeQuoteText(source);
  const starts = new Uint32Array(text.length);
  const ends = new Uint32Array(text.length);
  let sourceAt = 0;
  let normalizedAt = 0;
  const copyUntil = (end: number) => {
    while (sourceAt < end) {
      const first = source.charCodeAt(sourceAt);
      const second = source.charCodeAt(sourceAt + 1);
      const width =
        first >= 0xd800 &&
        first <= 0xdbff &&
        second >= 0xdc00 &&
        second <= 0xdfff
          ? 2
          : 1;
      for (let unit = 0; unit < width; unit++) {
        starts[normalizedAt] = sourceAt;
        ends[normalizedAt++] = sourceAt + width;
      }
      sourceAt += width;
    }
  };
  for (const whitespace of source.matchAll(/\s+/gu)) {
    copyUntil(whitespace.index);
    const end = whitespace.index + whitespace[0].length;
    if (whitespace.index !== 0 && end !== source.length) {
      starts[normalizedAt] = whitespace.index;
      ends[normalizedAt++] = end;
    }
    sourceAt = end;
  }
  copyUntil(source.length);
  return { text, starts, ends };
}
export function createQuoteSelector(
  source: string,
  start: number,
  end: number,
): QuoteSelector | null {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > source.length ||
    start >= end
  )
    return null;
  const selected = source.slice(start, end);
  if (/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(selected)) return null;
  const exact = normalizeQuoteText(selected);
  if (!exact || Array.from(exact).length > 2000) return null;
  const leading = source.slice(start, end).match(/^\s*/u)?.[0].length || 0;
  const trailing = source.slice(start, end).match(/\s*$/u)?.[0].length || 0;
  return {
    exact,
    prefix: Array.from(
      source
        .slice(0, start + leading)
        .replace(/\s+/gu, " ")
        .trimStart(),
    )
      .slice(-128)
      .join(""),
    suffix: Array.from(
      source
        .slice(end - trailing)
        .replace(/\s+/gu, " ")
        .trimEnd(),
    )
      .slice(0, 128)
      .join(""),
  };
}
/** Reuse this resolver for every annotation in the same rendered projection. */
export function createQuoteResolver(
  source: string,
): (quote: QuoteSelector) => QuoteResolution {
  const mapped = normalizedMap(source);
  return (quote) => {
    const exact = normalizeQuoteText(quote.exact);
    if (!exact) return { state: "missing" };
    const prefix = quote.prefix.replace(/\s+/gu, " ");
    const suffix = quote.suffix.replace(/\s+/gu, " ");
    const context = prefix + exact + suffix;
    const match = mapped.text.indexOf(context);
    if (match !== -1) {
      if (mapped.text.indexOf(context, match + 1) !== -1)
        return { state: "ambiguous" };
      const start = match + prefix.length;
      return {
        state: "matched",
        start: mapped.starts[start],
        end: mapped.ends[start + exact.length - 1],
      };
    }
    const candidate = mapped.text.indexOf(exact);
    if (candidate === -1) return { state: "missing" };
    return {
      state:
        mapped.text.indexOf(exact, candidate + 1) !== -1
          ? "ambiguous"
          : "stale",
    };
  };
}
export function resolveQuote(
  source: string,
  quote: QuoteSelector,
): QuoteResolution {
  return createQuoteResolver(source)(quote);
}
function markdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#!|])/g, "\\$1");
}
export function annotationNoteContent(
  annotation: Pick<Annotation, "id" | "documentId" | "quote" | "body">,
  title: string,
  date: string,
): DocumentContent {
  if (
    ![annotation.id, annotation.documentId].every((id) =>
      /^[a-f0-9]{32}$/.test(id),
    )
  )
    throw new Error("批注来源不可用。");
  return {
    title: Array.from(`摘录 · ${title}`).slice(0, 200).join(""),
    description: "",
    date,
    tags: [],
    category: "",
    cover: "",
    kind: "note",
    source: `> ${markdownText(annotation.quote.exact).replace(/\n/g, "\n> ")}\n\n${markdownText(annotation.body)}\n\n来源：[${markdownText(title)}](/articles/${annotation.documentId}/#annotation-${annotation.id})\n`,
  };
}
