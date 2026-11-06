export interface PassagePath {
  pathId: string;
  pathTitle: string;
  chapterId: string;
  chapterTitle: string;
}
export interface Passage {
  documentId: string;
  title: string;
  tags: string[];
  category: string;
  publishedAt: string;
  revision: string;
  anchor: string;
  kind: "paragraph" | "code" | "list" | "table";
  snippet: string;
  headings: { depth: number; slug: string; text: string }[];
  paths: PassagePath[];
  pathCount?: number;
}
export interface PassageResults {
  passages: Passage[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  truncated: boolean;
  message: string;
}
export interface PassageQuery {
  q: string;
  tag: string;
  pathId: string;
  limit: number;
  offset: number;
}
const identifier = /^[a-f0-9]{32}$/;
const passageAnchor = /^passage-[a-f0-9]{20}-\d+(?:-a)*$/;
const tokens = (query: string) =>
  query.normalize("NFKC").toLowerCase().trim().split(/\s+/u).filter(Boolean);

export function parsePassageQuery(search: string): {
  state: PassageQuery;
  error?: string;
} {
  const params = new URLSearchParams(search);
  const state: PassageQuery = {
    q: (params.get("q") || "").trim(),
    tag: params.get("tag") || "",
    pathId: params.get("pathId") || "",
    limit: Number(params.get("limit") ?? 12),
    offset: Number(params.get("offset") ?? 0),
  };
  if (new TextEncoder().encode(`/search/${search}`).length > 4096)
    return { state, error: "搜索地址过长，请缩短关键词或筛选条件。" };
  const accepted = ["q", "tag", "pathId", "limit", "offset"];
  for (const key of params.keys()) {
    if (!accepted.includes(key) || params.getAll(key).length !== 1)
      return {
        state,
        error: "搜索地址包含未知或重复参数，请重新输入搜索条件。",
      };
  }
  if ([...state.q].length > 256 || tokens(state.q).length > 16)
    return { state, error: "请使用不超过 256 个字符、16 个关键词搜索。" };
  if (
    /\p{Cc}/u.test(params.get("q") || "") ||
    /\p{Cc}/u.test(state.tag) ||
    [...state.tag].length > 64
  )
    return {
      state,
      error: "关键词与标签不能包含控制字符，标签不得超过 64 个字符。",
    };
  if (state.pathId && !identifier.test(state.pathId))
    return { state, error: "路线地址无效，请重新选择路线。" };
  for (const [name, min, max] of [
    ["limit", 1, 40],
    ["offset", 0, 2000],
  ] as const) {
    if (
      (params.has(name) && !/^\d+$/.test(params.get(name)!)) ||
      !Number.isInteger(state[name]) ||
      state[name] < min ||
      state[name] > max
    ) {
      return { state, error: "分页参数无效，请从第一页重新搜索。" };
    }
  }
  return { state };
}

export function passageParams(state: PassageQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.tag) params.set("tag", state.tag);
  if (state.pathId) params.set("pathId", state.pathId);
  if (state.limit !== 12) params.set("limit", String(state.limit));
  if (state.offset) params.set("offset", String(state.offset));
  return params;
}

export function passageHref(
  passage: Passage,
  query: string,
  selectedPath = "",
): string | null {
  if (
    !identifier.test(passage.documentId) ||
    !/^[a-f0-9]{64}$/.test(passage.revision) ||
    !passageAnchor.test(passage.anchor)
  )
    return null;
  const params = new URLSearchParams({
    passageRevision: passage.revision,
    q: query,
  });
  const path =
    selectedPath && passage.paths.find((path) => path.pathId === selectedPath);
  if (path && identifier.test(path.pathId)) params.set("path", path.pathId);
  return `/articles/${passage.documentId}/?${params}#${passage.anchor}`;
}

/** Return plain-text segments: rendering uses textContent, never HTML or query-derived RegExp. */
export function highlightSegments(
  source: string,
  query: string,
): { text: string; match: boolean }[] {
  if (!source) return [];
  const positions: { start: number; end: number }[] = [];
  let normalized = "";
  let cursor = 0;
  for (const point of source) {
    const folded = point.normalize("NFKC").toLowerCase();
    for (let i = 0; i < folded.length; i++)
      positions.push({ start: cursor, end: cursor + point.length });
    normalized += folded;
    cursor += point.length;
  }
  const hits = new Uint8Array(source.length);
  for (const token of new Set(tokens(query))) {
    let start = normalized.indexOf(token);
    while (start !== -1) {
      hits.fill(
        1,
        positions[start].start,
        positions[start + token.length - 1].end,
      );
      start = normalized.indexOf(token, start + 1);
    }
  }
  const segments: { text: string; match: boolean }[] = [];
  let begin = 0;
  for (let i = 1; i <= source.length; i++) {
    if (i === source.length || hits[i] !== hits[begin]) {
      segments.push({
        text: source.slice(begin, i),
        match: Boolean(hits[begin]),
      });
      begin = i;
    }
  }
  return segments;
}

export function passageTargetState(
  hash: string,
  requested: string | null,
  current: string | undefined,
  found: boolean,
) {
  if (!passageAnchor.test(hash.replace(/^#/, ""))) return "ignore";
  if (!found) return "missing";
  if (requested && !current) return "unverified";
  if (requested && requested !== current) return "updated";
  return "ready";
}

export function passageRecoveryHref(
  hash: string,
  search: string,
): string | null {
  if (!passageAnchor.test(hash.replace(/^#/, ""))) return null;
  const query = new URLSearchParams(search).get("q") || "";
  return `/search/${query ? `?${new URLSearchParams({ q: query })}` : ""}`;
}
