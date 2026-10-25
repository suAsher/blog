export const STORAGE_KEY = 'asher-reading-v1';

export interface ReadingEntry {
  bookmarked: boolean;
  read: boolean;
  /** Percentage of the article, from 0 to 100. */
  progress: number;
  updatedAt: number;
}

export type ReadingState = Record<string, ReadingEntry>;

const emptyEntry: ReadingEntry = { bookmarked: false, read: false, progress: 0, updatedAt: 0 };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isSafeId = (id: string): boolean =>
  id.trim().length > 0 && !['__proto__', 'constructor', 'prototype'].includes(id);
const clampProgress = (value: number): number => Math.max(0, Math.min(100, value));

function validateEntry(value: unknown): ReadingEntry | undefined {
  if (!isRecord(value) || typeof value.bookmarked !== 'boolean' || typeof value.read !== 'boolean' ||
      !isFiniteNumber(value.progress) || !isFiniteNumber(value.updatedAt) || value.updatedAt < 0) {
    return undefined;
  }
  return {
    bookmarked: value.bookmarked,
    read: value.read,
    progress: clampProgress(value.progress),
    updatedAt: value.updatedAt,
  };
}

/** Untrusted browser storage and imported files are reduced to the known schema. */
export function parseState(raw: string | null): ReadingState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      const entry = validateEntry(value);
      return isSafeId(id) && entry ? [[id, entry]] : [];
    }));
  } catch {
    return {};
  }
}

export function readState(storage?: Pick<Storage, 'getItem'>): ReadingState {
  try {
    const target = storage ?? globalThis.localStorage;
    return parseState(target?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return {};
  }
}

/** Returns a new state. Existing entries and caller-provided patches are never mutated. */
export function updateEntry(
  state: ReadingState,
  id: string,
  patch: Partial<ReadingEntry>,
  now = Date.now(),
): ReadingState {
  if (!isSafeId(id)) return { ...state };
  const previous = validateEntry(state[id]) ?? emptyEntry;
  const next: ReadingEntry = {
    bookmarked: typeof patch.bookmarked === 'boolean' ? patch.bookmarked : previous.bookmarked,
    read: typeof patch.read === 'boolean' ? patch.read : previous.read,
    progress: isFiniteNumber(patch.progress) ? clampProgress(patch.progress) : previous.progress,
    updatedAt: isFiniteNumber(now) && now >= 0 ? now : previous.updatedAt,
  };
  return { ...state, [id]: next };
}

/** False means the caller should warn that the browser cannot persist this change. */
export function saveState(state: ReadingState, storage?: Pick<Storage, 'setItem'>): boolean {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
