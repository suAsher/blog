export interface HighlightSegment { text: string; match: boolean }
export function commandMatches(title: string, aliases: string[], query: string): boolean {
  const term = query.replace(/^\s*>\s*/, '').trim().toLocaleLowerCase();
  return !term || [title, ...aliases].some(value => value.toLocaleLowerCase().includes(term));
}
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const lower = text.toLocaleLowerCase();
  const tokens = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))].slice(0, 12);
  const ranges: { start: number; end: number }[] = [];
  for (const token of tokens) {
    let at = lower.indexOf(token);
    while (at >= 0 && ranges.length < 256) { ranges.push({ start: at, end: at + token.length }); at = lower.indexOf(token, at + 1); }
  }
  const ordered = ranges.sort((a, b) => a.start - b.start);
  const merged = ordered.reduce<{ start: number; end: number }[]>((result, range) => {
    const last = result.at(-1);
    return last && range.start <= last.end ? [...result.slice(0, -1), { start: last.start, end: Math.max(last.end, range.end) }] : [...result, range];
  }, []);
  const segments: HighlightSegment[] = []; let cursor = 0;
  for (const range of merged) {
    if (cursor < range.start) segments.push({ text: text.slice(cursor, range.start), match: false });
    segments.push({ text: text.slice(range.start, range.end), match: true }); cursor = range.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}
export function nextCommandIndex(current: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : length - 1;
  return (current + direction + length) % length;
}
