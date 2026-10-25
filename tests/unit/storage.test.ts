import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseState, readState, saveState, STORAGE_KEY, updateEntry, type ReadingState } from '../../src/lib/storage';

const saved: ReadingState = {
  'reading-notes': { bookmarked: true, read: false, progress: 42, updatedAt: 1000 },
};

afterEach(() => vi.unstubAllGlobals());

describe('reading state parsing', () => {
  it('restores valid persisted bookmarks and reading progress', () => {
    expect(parseState(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([null, '', '{invalid', 'null', '[]', '42', '"string"'])('survives corrupt storage: %s', (value) => {
    expect(parseState(value)).toEqual({});
  });

  it('ignores malformed entries while preserving independent valid data', () => {
    expect(parseState(JSON.stringify({ ...saved, bad: { bookmarked: 'true' }, missing: null, list: [] }))).toEqual(saved);
  });

  it('discards prototype-sensitive keys and never changes Object.prototype', () => {
    const raw = '{"__proto__":{"bookmarked":true,"read":false,"progress":12,"updatedAt":1},"constructor":{"bookmarked":true,"read":false,"progress":12,"updatedAt":1},"prototype":{"bookmarked":true,"read":false,"progress":12,"updatedAt":1}}';
    expect(Object.keys(parseState(raw))).toEqual([]);
    expect(Object.prototype).not.toHaveProperty('bookmarked');
  });

  it('clamps saved progress and strips unexpected fields', () => {
    const parsed = parseState(JSON.stringify({
      high: { bookmarked: false, read: true, progress: 999, updatedAt: 2, untrusted: '<script>' },
      low: { bookmarked: true, read: false, progress: -5, updatedAt: 0 },
    }));
    expect(parsed.high).toEqual({ bookmarked: false, read: true, progress: 100, updatedAt: 2 });
    expect(parsed.low?.progress).toBe(0);
  });

  it('rejects invalid timestamps, primitive entries and invalid progress types', () => {
    const malformed = {
      negative: { bookmarked: true, read: false, progress: 40, updatedAt: -1 },
      invalid: { bookmarked: true, read: false, progress: '40', updatedAt: 1 },
      primitive: 7,
    };
    expect(parseState(JSON.stringify(malformed))).toEqual({});
  });
});

describe('immutable reading updates', () => {
  it('updates one article without changing the original object or other entries', () => {
    const updated = updateEntry(saved, 'reading-notes', { read: true }, 2000);
    expect(updated['reading-notes']).toEqual({ bookmarked: true, read: true, progress: 42, updatedAt: 2000 });
    expect(saved['reading-notes']?.read).toBe(false);
    expect(updated).not.toBe(saved);
    expect(updated['reading-notes']).not.toBe(saved['reading-notes']);
  });

  it('creates a default entry, accepts a nested content slug and clamps progress', () => {
    const updated = updateEntry(saved, 'notes/first', { progress: 120 }, 3000);
    expect(updated['notes/first']).toEqual({ bookmarked: false, read: false, progress: 100, updatedAt: 3000 });
    expect(updateEntry({}, 'first', { progress: -10 }, 0).first?.progress).toBe(0);
    expect(updated['reading-notes']).toEqual(saved['reading-notes']);
  });

  it('rejects unsafe article identifiers', () => {
    for (const id of ['', '__proto__', 'constructor', 'prototype']) {
      expect(updateEntry(saved, id, { bookmarked: true }, 2000)).toEqual(saved);
    }
  });

  it('ignores invalid runtime patches and timestamps', () => {
    const updated = updateEntry(saved, 'reading-notes', {
      bookmarked: 'true', read: null, progress: Number.NaN, updatedAt: -1,
    } as never, -5);
    expect(updated['reading-notes']).toEqual(saved['reading-notes']);
    expect(updateEntry(saved, 'reading-notes', { progress: Infinity }, 2000)['reading-notes']?.progress).toBe(42);
  });

  it('uses the current time when no timestamp is supplied', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(5000);
    expect(updateEntry({}, 'first', {}).first?.updatedAt).toBe(5000);
    vi.restoreAllMocks();
  });
});

describe('browser storage boundary', () => {
  it('reads and writes the versioned key through an injected storage object', () => {
    const getItem = vi.fn(() => JSON.stringify(saved));
    const setItem = vi.fn();
    expect(readState({ getItem })).toEqual(saved);
    expect(getItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(saveState(saved, { setItem })).toBe(true);
    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(saved));
  });

  it('returns a usable empty state when reading storage is forbidden', () => {
    expect(readState({ getItem: () => { throw new Error('SecurityError'); } })).toEqual({});
  });

  it('reports a failed write so the UI can explain unavailable persistence', () => {
    expect(saveState(saved, { setItem: () => { throw new Error('QuotaExceededError'); } })).toBe(false);
  });

  it('supports browser localStorage and environments where it is unavailable', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved), setItem });
    expect(readState()).toEqual(saved);
    expect(saveState(saved)).toBe(true);
    vi.stubGlobal('localStorage', undefined);
    expect(readState()).toEqual({});
    expect(saveState(saved)).toBe(false);
  });
});
