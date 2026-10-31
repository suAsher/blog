export function parseCodeCaption(text: string, lineCount: number) {
  if (text.length > 240 || lineCount < 1 || lineCount > 1000) return null;
  const match =
    /^代码文件：[\s`]*([\w./-]{1,120})`?(?:[；;]\s*重点行：[\s`]*([\d, -]+)`?)?\s*$/.exec(
      text.trim().replace(/。$/, ""),
    );
  if (
    !match ||
    match[1].split("/").some((part) => !part || part === ".." || part === ".")
  )
    return null;
  const highlights = new Set<number>();
  for (const token of (match[2] || "").split(",").filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(token.trim());
    if (!range) return null;
    const first = Number(range[1]),
      last = Number(range[2] || first);
    if (first < 1 || last < first || last > lineCount || last - first > 100)
      return null;
    for (let line = first; line <= last; line++) highlights.add(line);
  }
  return {
    filename: match[1],
    highlights: [...highlights].sort((a, b) => a - b),
  };
}

export function articleOverview(
  headings: { depth: number; text: string; slug: string }[],
) {
  return headings
    .filter((heading) => heading.depth === 2)
    .slice(0, 4)
    .map(({ text, slug }) => ({ text, slug }));
}
