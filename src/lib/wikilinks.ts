export interface WikiCompletionRange {
  start: number;
  end: number;
  query: string;
}

export interface WikiCompletionTarget {
  id: string;
  title: string;
}

interface Fence {
  marker: "`" | "~";
  length: number;
  closing: boolean;
}

function fenceAt(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0] as Fence["marker"],
    length: match[1].length,
    closing: line.slice(match[0].length).trim() === "",
  };
}

function codeState(source: string, cursor: number): {
  fenced: boolean;
  inline: boolean;
} {
  const prefix = source.slice(0, cursor);
  const lines = prefix.split("\n");
  let openFence: Fence | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const fence = fenceAt(lines[index]);
    if (fence) {
      if (!openFence) openFence = fence;
      else if (
        fence.closing &&
        openFence.marker === fence.marker &&
        fence.length >= openFence.length
      )
        openFence = null;
    }
    if (index < lines.length - 1 || openFence) continue;
  }
  if (openFence) return { fenced: true, inline: false };

  const line = lines.at(-1) || "";
  let inlineDelimiter = 0;
  for (let index = 0; index < line.length; ) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (line[end] === "`") end += 1;
    const length = end - index;
    inlineDelimiter = inlineDelimiter === length ? 0 : inlineDelimiter || length;
    index = end;
  }
  return { fenced: false, inline: inlineDelimiter > 0 };
}

export function wikiCompletionRange(
  source: string,
  selectionStart: number,
  selectionEnd: number,
): WikiCompletionRange | null {
  if (
    selectionStart !== selectionEnd ||
    selectionStart < 0 ||
    selectionStart > source.length
  )
    return null;
  const state = codeState(source, selectionStart);
  if (state.fenced || state.inline) return null;

  const lineStart = source.lastIndexOf("\n", selectionStart - 1) + 1;
  const open = source.lastIndexOf("[[", selectionStart - 1);
  if (open < lineStart) return null;
  const query = source.slice(open + 2, selectionStart);
  if (
    query.includes("]]" ) ||
    query.includes("[[") ||
    /[\u0000-\u001f\u007f`\[\]|]/u.test(query)
  )
    return null;
  return { start: open, end: selectionStart, query };
}

function safeWikiTitle(title: string): string {
  return title
    .replace(/[\u0000-\u001f\u007f|\[\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

export function applyWikiCompletion(
  source: string,
  range: Pick<WikiCompletionRange, "start" | "end">,
  target: WikiCompletionTarget,
): { value: string; cursor: number } {
  const title = safeWikiTitle(target.title) || target.id;
  const token = `[[${target.id}|${title}]]`;
  return {
    value: source.slice(0, range.start) + token + source.slice(range.end),
    cursor: range.start + token.length,
  };
}
