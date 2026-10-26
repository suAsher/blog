export const STORAGE_KEY = 'asher-reading-v1';

export interface ReadingReview {
  enabled: boolean;
  step: number;
  dueAt: string | null;
  lastReviewedAt: string | null;
}

export interface ReadingEntry {
  bookmarked: boolean;
  read: boolean;
  /** Percentage of the article, from 0 to 100. */
  progress: number;
  updatedAt: number;
  /** Optional so existing v1 JSON imports remain valid. */
  review?: ReadingReview;
}

export type ReadingState = Record<string, ReadingEntry>;

const emptyEntry: ReadingEntry = { bookmarked: false, read: false, progress: 0, updatedAt: 0 };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const utf8 = new TextEncoder();
export const isSafeReadingKey = (id: string): boolean => {
  if (id.trim() !== id || id.length === 0 || utf8.encode(id).byteLength > 240) return false;
  if (/\p{Cc}/u.test(id) || /[\\?#<>"']/.test(id)) return false;
  return id.split('/').every(segment => segment.length > 0 &&
    !['.', '..', '__proto__', 'constructor', 'prototype'].includes(segment));
};
const clampProgress = (value: number): number => Math.max(0, Math.min(100, value));

const isTimestamp = (value: unknown): value is string | null =>
  value === null || typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

function validateReview(value: unknown): ReadingReview | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
      !Number.isInteger(value.step) || (value.step as number) < 0 || (value.step as number) > 3 ||
      !isTimestamp(value.dueAt) || !isTimestamp(value.lastReviewedAt)) return undefined;
  return {
    enabled: value.enabled,
    step: value.step as number,
    dueAt: value.dueAt,
    lastReviewedAt: value.lastReviewedAt,
  };
}

function validateEntry(value: unknown): ReadingEntry | undefined {
  if (!isRecord(value) || typeof value.bookmarked !== 'boolean' || typeof value.read !== 'boolean' ||
      !isFiniteNumber(value.progress) || !isFiniteNumber(value.updatedAt) || value.updatedAt < 0) {
    return undefined;
  }
  const entry: ReadingEntry = {
    bookmarked: value.bookmarked,
    read: value.read,
    progress: clampProgress(value.progress),
    updatedAt: value.updatedAt,
  };
  const review = validateReview(value.review);
  return review ? { ...entry, review } : entry;
}

/** Untrusted browser storage and imported files are reduced to the known schema. */
export function parseState(raw: string | null): ReadingState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      const entry = validateEntry(value);
      return isSafeReadingKey(id) && entry ? [[id, entry]] : [];
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
  if (!isSafeReadingKey(id)) return { ...state };
  const previous = validateEntry(state[id]) ?? emptyEntry;
  const review = patch.review === undefined ? previous.review : validateReview(patch.review) ?? previous.review;
  const next: ReadingEntry = {
    bookmarked: typeof patch.bookmarked === 'boolean' ? patch.bookmarked : previous.bookmarked,
    read: typeof patch.read === 'boolean' ? patch.read : previous.read,
    progress: isFiniteNumber(patch.progress) ? clampProgress(patch.progress) : previous.progress,
    updatedAt: isFiniteNumber(now) && now >= 0 ? now : previous.updatedAt,
    ...(review ? { review } : {}),
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
