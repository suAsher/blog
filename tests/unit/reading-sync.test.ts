import { describe, expect, it } from 'vitest';
import type { ReadingState } from '../../src/lib/storage';
import {
  applyReadingSyncResponse,
  applyReadingReviewAction,
  emptyReadingSyncStore,
  markOperationsSent,
  mergeReadingSyncStores,
  parseReadingSyncStore,
  queueReadingPatch,
  readingBatchRequest,
  readingPatchBase,
  readingSyncStoreFits,
  READING_SYNC_MAX_OUTBOX,
  reconcileReadingSnapshot,
  resolveReadingConflict,
  selectOperationBatch,
  type ReadingServerEntry,
  writeWithEpochGuard,
} from '../../src/lib/reading-sync';

const serverEntry = (overrides: Partial<ReadingServerEntry> = {}): ReadingServerEntry => ({
  bookmarked: false,
  read: false,
  progress: 0,
  updatedAt: 10,
  fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 0 },
  ...overrides,
});

describe('reading sync queue', () => {
  it('coalesces only unsent patches and keeps exact per-field bases', () => {
    const initial = {
      ...emptyReadingSyncStore(),
      entries: { article: serverEntry({ fieldRevisions: { bookmarked: 4, read: 2, progress: 7, review: 1 } }) },
    };
    const first = queueReadingPatch(initial, 'article', { progress: 20 }, '11111111-1111-4111-8111-111111111111', 100);
    const coalesced = queueReadingPatch(first, 'article', { bookmarked: true }, '22222222-2222-4222-8222-222222222222', 101);
    expect(coalesced.outbox).toHaveLength(1);
    expect(coalesced.outbox[0]).toMatchObject({
      opId: '22222222-2222-4222-8222-222222222222',
      base: { progress: 7, bookmarked: 4 },
      patch: { progress: 20, bookmarked: true },
      sent: false,
    });
    expect(coalesced.settled).toContain('11111111-1111-4111-8111-111111111111');

    const sent = markOperationsSent(coalesced, [coalesced.outbox[0].opId]);
    const later = queueReadingPatch(sent, 'article', { progress: 35 }, '33333333-3333-4333-8333-333333333333', 102);
    expect(later.outbox).toHaveLength(2);
    expect(later.outbox[0].patch.progress).toBe(20);
    expect(later.outbox[1]).toMatchObject({ base: { progress: 7 }, patch: { progress: 35 }, sent: false });
  });

  it('keeps review actions separate because completion is not idempotent across actions', () => {
    const enabled = queueReadingPatch(emptyReadingSyncStore(), 'article', { reviewAction: 'enable' }, '11111111-1111-4111-8111-111111111111', 100);
    const completed = queueReadingPatch(enabled, 'article', { reviewAction: 'complete' }, '22222222-2222-4222-8222-222222222222', 101);
    expect(completed.outbox).toHaveLength(2);
    expect(completed.outbox.map(item => item.patch.reviewAction)).toEqual(['enable', 'complete']);
  });

  it('retires an expanded unsent UUID and preserves the original field base across a newer snapshot', () => {
    const base = { ...emptyReadingSyncStore(), entries: { article: serverEntry({ fieldRevisions: { bookmarked: 0, read: 3, progress: 0, review: 0 } }) } };
    const stale = queueReadingPatch(base, 'article', { read: true }, '11111111-1111-4111-8111-111111111111', 1);
    const learned = { ...stale, entries: { article: serverEntry({ read: false, fieldRevisions: { bookmarked: 4, read: 10, progress: 0, review: 0 } }) } };
    const expanded = queueReadingPatch(learned, 'article', { bookmarked: true }, '22222222-2222-4222-8222-222222222222', 2);
    expect(expanded.outbox[0]).toMatchObject({
      opId: '22222222-2222-4222-8222-222222222222',
      base: { read: 3, bookmarked: 4 }, patch: { read: true, bookmarked: true },
    });
    expect(mergeReadingSyncStores(stale, expanded).outbox).toEqual(expanded.outbox);
    expect(mergeReadingSyncStores(expanded, stale).outbox).toEqual(expanded.outbox);
  });

  it('bounds API batches by both operation count and UTF-8 JSON bytes', () => {
    let store = emptyReadingSyncStore();
    for (let index = 0; index < 40; index++) {
      store = queueReadingPatch(store, `文章-${index}-${'界'.repeat(45)}`, { read: true }, `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, index);
    }
    const batch = selectOperationBatch(store.outbox);
    expect(batch.length).toBeLessThanOrEqual(32);
    expect(new TextEncoder().encode(JSON.stringify(readingBatchRequest(batch))).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it('serializes operations for one key so a later edit can be rebased after acknowledgement', () => {
    const first = queueReadingPatch(emptyReadingSyncStore(), 'article', { reviewAction: 'enable' }, '11111111-1111-4111-8111-111111111111', 100);
    const second = queueReadingPatch(first, 'article', { reviewAction: 'complete' }, '22222222-2222-4222-8222-222222222222', 101);
    expect(selectOperationBatch(second.outbox).map(item => item.opId)).toEqual([first.outbox[0].opId]);
  });

  it('retries the immutable sent operation before selecting later unsent work', () => {
    const first = queueReadingPatch(emptyReadingSyncStore(), 'first', { read: true }, '11111111-1111-4111-8111-111111111111', 100);
    const marked = markOperationsSent(first, [first.outbox[0].opId]);
    const second = queueReadingPatch(marked, 'second', { bookmarked: true }, '22222222-2222-4222-8222-222222222222', 101);
    expect(selectOperationBatch(second.outbox).map(item => item.key)).toEqual(['first']);
  });

  it('rejects invalid queue inputs without changing the store', () => {
    const store = emptyReadingSyncStore();
    for (const [key, patch, id, now] of [
      ['../bad', { read: true }, '11111111-1111-4111-8111-111111111111', 1],
      ['good', {}, '11111111-1111-4111-8111-111111111111', 1],
      ['good', { read: true }, 'bad', 1],
      ['good', { read: true }, '11111111-1111-4111-8111-111111111111', -1],
    ] as const) {
      expect(queueReadingPatch(store, key, patch, id, now)).toBe(store);
    }
  });
});

describe('spaced review model', () => {
  const day = 86_400_000;

  it('uses the 1/3/7/30-day schedule, caps at step three and preserves the last review on disable', () => {
    const enabled = applyReadingReviewAction(undefined, 'enable', 0);
    expect(enabled).toEqual({ enabled: true, step: 0, dueAt: new Date(day).toISOString(), lastReviewedAt: null });
    const stepOne = applyReadingReviewAction(enabled, 'complete', day);
    expect(stepOne).toMatchObject({ step: 1, dueAt: new Date(day * 4).toISOString(), lastReviewedAt: new Date(day).toISOString() });
    const stepTwo = applyReadingReviewAction(stepOne, 'complete', day * 4);
    expect(stepTwo).toMatchObject({ step: 2, dueAt: new Date(day * 11).toISOString() });
    const stepThree = applyReadingReviewAction(stepTwo, 'complete', day * 11);
    expect(stepThree).toMatchObject({ step: 3, dueAt: new Date(day * 41).toISOString() });
    const capped = applyReadingReviewAction(stepThree, 'complete', day * 41);
    expect(capped).toMatchObject({ step: 3, dueAt: new Date(day * 71).toISOString() });
    expect(applyReadingReviewAction(capped, 'disable', day * 42)).toEqual({
      enabled: false, step: 3, dueAt: null, lastReviewedAt: new Date(day * 41).toISOString(),
    });
  });
});

describe('reading sync reconciliation', () => {
  it('migrates legacy local truth only into empty server fields', () => {
    const local: ReadingState = {
      article: { bookmarked: false, read: true, progress: 44, updatedAt: 1 },
    };
    const result = reconcileReadingSnapshot(local, emptyReadingSyncStore(), {
      revision: 8,
      entries: {
        article: serverEntry({
          bookmarked: true,
          fieldRevisions: { bookmarked: 6, read: 0, progress: 0, review: 0 },
        }),
      },
    }, () => '11111111-1111-4111-8111-111111111111', 100);
    expect(result.store.migrated).toBe(true);
    expect(result.store.outbox[0]).toMatchObject({
      base: { read: 0, progress: 0 },
      patch: { read: true, progress: 44 },
    });
    expect(Object.keys(result.store.outbox[0].patch).sort()).toEqual(['progress', 'read']);
    expect(result.local.article).toMatchObject({ bookmarked: true, read: true, progress: 44 });
  });

  it('migrates an enabled legacy review once but skips empty visited records', () => {
    const local: ReadingState = {
      empty: { bookmarked: false, read: false, progress: 0, updatedAt: 5 },
      review: {
        bookmarked: false, read: false, progress: 0, updatedAt: 5,
        review: { enabled: true, step: 2, dueAt: '2026-10-27T00:00:00Z', lastReviewedAt: null },
      },
    };
    const result = reconcileReadingSnapshot(local, emptyReadingSyncStore(), { revision: 0, entries: {} },
      () => '11111111-1111-4111-8111-111111111111', 100);
    expect(result.store.outbox).toHaveLength(1);
    expect(result.store.outbox[0]).toMatchObject({ key: 'review', patch: { reviewAction: 'enable' } });
  });

  it('overlays a newer local edit over a late GET response', () => {
    const queued = queueReadingPatch(emptyReadingSyncStore(), 'article', { progress: 80 }, '11111111-1111-4111-8111-111111111111', 100);
    const result = reconcileReadingSnapshot({}, { ...queued, migrated: true }, {
      revision: 2,
      entries: { article: serverEntry({ progress: 20, fieldRevisions: { bookmarked: 0, read: 0, progress: 2, review: 0 } }) },
    }, () => 'unused', 100);
    expect(result.local.article?.progress).toBe(80);
  });

  it('ignores an older snapshot after a newer response is known', () => {
    const store = { ...emptyReadingSyncStore(), revision: 9, migrated: true };
    const local: ReadingState = { article: { bookmarked: true, read: false, progress: 0, updatedAt: 9 } };
    expect(reconcileReadingSnapshot(local, store, { revision: 8, entries: {} }, () => 'unused', 100)).toEqual({ local, store });
  });

  it('applies an acknowledgement without erasing a later pending local edit', () => {
    const first = queueReadingPatch(emptyReadingSyncStore(), 'article', { progress: 20 }, '11111111-1111-4111-8111-111111111111', 100);
    const sent = markOperationsSent(first, [first.outbox[0].opId]);
    const later = queueReadingPatch(sent, 'article', { progress: 70 }, '22222222-2222-4222-8222-222222222222', 101);
    const result = applyReadingSyncResponse({}, later, {
      revision: 3,
      results: [{
        opId: first.outbox[0].opId,
        key: 'article',
        applied: ['progress'],
        conflicts: [],
        entry: serverEntry({ progress: 20, fieldRevisions: { bookmarked: 0, read: 0, progress: 3, review: 0 } }),
      }],
    });
    expect(result.local.article?.progress).toBe(70);
    expect(result.store.outbox).toHaveLength(1);
    expect(result.store.entries.article.progress).toBe(20);
    expect(result.store.outbox[0].base.progress).toBe(3);
  });

  it('rebases only later same-key fields applied by the acknowledged operation', () => {
    const initial = { ...emptyReadingSyncStore(), entries: { article: serverEntry({ fieldRevisions: { bookmarked: 4, read: 0, progress: 0, review: 0 } }) } };
    const first = markOperationsSent(queueReadingPatch(initial, 'article', { progress: 20 }, '11111111-1111-4111-8111-111111111111', 1), ['11111111-1111-4111-8111-111111111111']);
    const later = queueReadingPatch(first, 'article', { progress: 70, bookmarked: true }, '22222222-2222-4222-8222-222222222222', 2);
    const store = { ...later, entries: { article: serverEntry({ fieldRevisions: { bookmarked: 4, read: 0, progress: 10, review: 0 } }) } };
    const result = applyReadingSyncResponse({}, store, { revision: 3, results: [{
      opId: first.outbox[0].opId, key: 'article', applied: ['progress'], conflicts: [],
      entry: serverEntry({ progress: 20, fieldRevisions: { bookmarked: 4, read: 0, progress: 3, review: 0 } }),
    }] });
    expect(result.store.outbox[0].base).toEqual({ progress: 3, bookmarked: 4 });
  });

  it('does not rebase unrelated or conflicted pending intent from newer snapshots', () => {
    const a = markOperationsSent(queueReadingPatch(emptyReadingSyncStore(), 'a', { read: true }, '11111111-1111-4111-8111-111111111111', 1), ['11111111-1111-4111-8111-111111111111']);
    const queuedB = queueReadingPatch(a, 'b', { read: false }, '22222222-2222-4222-8222-222222222222', 2);
    const b = { ...queuedB, entries: { b: serverEntry({ read: true, fieldRevisions: { bookmarked: 0, read: 10, progress: 0, review: 0 } }) } };
    const result = applyReadingSyncResponse({}, b, { revision: 11, results: [{
      opId: a.outbox[0].opId, key: 'a', applied: [], conflicts: ['read'],
      entry: serverEntry({ read: false, fieldRevisions: { bookmarked: 0, read: 11, progress: 0, review: 0 } }),
    }] });
    expect(result.store.outbox[0].base.read).toBe(0);
  });

  it('does not regress revision or canonical fields when a delayed retry receipt is older', () => {
    const queued = markOperationsSent(
      queueReadingPatch(emptyReadingSyncStore(), 'article', { progress: 20 }, '11111111-1111-4111-8111-111111111111', 100),
      ['11111111-1111-4111-8111-111111111111'],
    );
    const current = {
      ...queued,
      revision: 5,
      entries: {
        article: serverEntry({ progress: 75, updatedAt: 500, fieldRevisions: { bookmarked: 0, read: 0, progress: 5, review: 0 } }),
      },
    };
    const result = applyReadingSyncResponse({}, current, {
      revision: 3,
      results: [{
        opId: queued.outbox[0].opId,
        key: 'article',
        applied: ['progress'],
        conflicts: [],
        entry: serverEntry({ progress: 20, updatedAt: 300, fieldRevisions: { bookmarked: 0, read: 0, progress: 3, review: 0 } }),
      }],
    });
    expect(result.store.revision).toBe(5);
    expect(result.store.entries.article.progress).toBe(75);
    expect(result.store.entries.article.fieldRevisions.progress).toBe(5);
    expect(result.local.article?.progress).toBe(75);
  });

  it('exposes conflicts and supports keep-server or reapply with the new base', () => {
    const queued = markOperationsSent(
      queueReadingPatch(emptyReadingSyncStore(), 'article', { bookmarked: true }, '11111111-1111-4111-8111-111111111111', 100),
      ['11111111-1111-4111-8111-111111111111'],
    );
    const conflicted = applyReadingSyncResponse({}, queued, {
      revision: 6,
      results: [{
        opId: queued.outbox[0].opId,
        key: 'article',
        applied: [],
        conflicts: ['bookmarked'],
        entry: serverEntry({ bookmarked: false, fieldRevisions: { bookmarked: 6, read: 0, progress: 0, review: 0 } }),
      }],
    });
    expect(conflicted.local.article?.bookmarked).toBe(false);
    expect(conflicted.store.conflicts).toHaveLength(1);

    const reapplied = resolveReadingConflict(conflicted.local, conflicted.store, conflicted.store.conflicts[0].id, 'reapply', '22222222-2222-4222-8222-222222222222', 200);
    expect(reapplied.store.outbox[0]).toMatchObject({ base: { bookmarked: 6 }, patch: { bookmarked: true } });
    expect(reapplied.local.article?.bookmarked).toBe(true);

    const kept = resolveReadingConflict(conflicted.local, conflicted.store, conflicted.store.conflicts[0].id, 'server', 'unused', 200);
    expect(kept.store.conflicts).toHaveLength(0);
    expect(kept.local.article?.bookmarked).toBe(false);
  });

  it('reapply retires a later pending same-field intent and uses the current server revision', () => {
    const first = markOperationsSent(
      queueReadingPatch(emptyReadingSyncStore(), 'article', { bookmarked: true }, '11111111-1111-4111-8111-111111111111', 1),
      ['11111111-1111-4111-8111-111111111111'],
    );
    const later = queueReadingPatch(first, 'article', { bookmarked: false }, '22222222-2222-4222-8222-222222222222', 2);
    const conflicted = applyReadingSyncResponse({}, later, { revision: 6, results: [{
      opId: first.outbox[0].opId, key: 'article', applied: [], conflicts: ['bookmarked'],
      entry: serverEntry({ bookmarked: false, fieldRevisions: { bookmarked: 6, read: 0, progress: 0, review: 0 } }),
    }] });
    const reapplied = resolveReadingConflict(conflicted.local, conflicted.store, conflicted.store.conflicts[0].id,
      'reapply', '33333333-3333-4333-8333-333333333333', 3);
    expect(reapplied.store.outbox).toHaveLength(1);
    expect(reapplied.store.outbox[0]).toMatchObject({
      opId: '33333333-3333-4333-8333-333333333333', patch: { bookmarked: true }, base: { bookmarked: 6 },
    });
    expect(reapplied.store.settled).toContain('22222222-2222-4222-8222-222222222222');
  });

  it('records a review conflict and ignores unknown or malformed response rows', () => {
    const queued = markOperationsSent(
      queueReadingPatch(emptyReadingSyncStore(), 'article', { reviewAction: 'enable' }, '11111111-1111-4111-8111-111111111111', 100),
      ['11111111-1111-4111-8111-111111111111'],
    );
    const entry = serverEntry({
      review: { enabled: false, step: 0, dueAt: null, lastReviewedAt: null },
      fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 4 },
    });
    const result = applyReadingSyncResponse({}, queued, {
      revision: 4,
      results: [
        { opId: '99999999-9999-4999-8999-999999999999', key: 'article', applied: [], conflicts: [], entry },
        { opId: queued.outbox[0].opId, key: 'wrong', applied: [], conflicts: [], entry },
        { opId: queued.outbox[0].opId, key: 'article', applied: [], conflicts: ['unknown', 'review'], entry },
      ],
    });
    expect(result.store.conflicts[0]).toMatchObject({ field: 'review', desired: 'enable', serverRevision: 4 });
    expect(resolveReadingConflict(result.local, result.store, 'missing', 'server', 'unused', 1)).toEqual({ local: result.local, store: result.store });
  });
});

describe('reading sync persistence hardening', () => {
  it('rolls back an exact journal write when the logout epoch changes during persistence', () => {
    let epoch: string | null = 'before';
    const stored = new Map<string, string>();
    const written = writeWithEpochGuard('before', () => epoch, () => {
      stored.set('intent-id', 'private intent');
      epoch = 'after';
    }, () => stored.delete('intent-id'));
    expect(written).toBe(false);
    expect(stored.has('intent-id')).toBe(false);
    expect(writeWithEpochGuard('before', () => epoch, () => stored.set('late', 'intent'), () => stored.delete('late'))).toBe(false);
    expect(stored.has('late')).toBe(false);
  });

  it('merges concurrent tab queues and uses tombstones to prevent acknowledged resurrection', () => {
    const first = queueReadingPatch(emptyReadingSyncStore(), 'first', { read: true }, '11111111-1111-4111-8111-111111111111', 10);
    const second = queueReadingPatch(emptyReadingSyncStore(), 'second', { bookmarked: true }, '22222222-2222-4222-8222-222222222222', 11);
    const merged = mergeReadingSyncStores(first, second);
    expect(merged.outbox.map(item => item.key)).toEqual(['first', 'second']);

    const staleBase = queueReadingPatch(emptyReadingSyncStore(), 'same', { read: true }, '33333333-3333-4333-8333-333333333333', 12);
    const rebased = {
      ...staleBase,
      outbox: [{ ...staleBase.outbox[0], base: { read: 7 } }],
    };
    expect(mergeReadingSyncStores(staleBase, rebased).outbox[0].base).toEqual({ read: 7 });

    const sent = markOperationsSent(staleBase, [staleBase.outbox[0].opId]);
    expect(mergeReadingSyncStores(sent, rebased).outbox[0]).toEqual(sent.outbox[0]);
    expect(mergeReadingSyncStores(rebased, sent).outbox[0]).toEqual(sent.outbox[0]);
    expect(mergeReadingSyncStores(sent, rebased).integrityError).toBe(true);

    const acknowledged = applyReadingSyncResponse({}, markOperationsSent(first, [first.outbox[0].opId]), {
      revision: 1,
      results: [{
        opId: first.outbox[0].opId, key: 'first', applied: ['read'], conflicts: [],
        entry: serverEntry({ read: true, fieldRevisions: { bookmarked: 0, read: 1, progress: 0, review: 0 } }),
      }],
    }).store;
    const staleTab = { ...first, revision: 0 };
    expect(mergeReadingSyncStores(acknowledged, staleTab).outbox).toEqual([]);
    expect(mergeReadingSyncStores(acknowledged, staleTab).settled).toContain(first.outbox[0].opId);
  });

  it('replays a crash journal idempotently without tombstoning newer pending work', () => {
    const crashed = queueReadingPatch(emptyReadingSyncStore(), 'article', { read: true }, '11111111-1111-4111-8111-111111111111', 1);
    expect(queueReadingPatch(crashed, 'article', { read: true }, '11111111-1111-4111-8111-111111111111', 1)).toBe(crashed);

    const newer = queueReadingPatch(emptyReadingSyncStore(), 'newer', { bookmarked: true }, '22222222-2222-4222-8222-222222222222', 2);
    const settledCrash = { ...newer, settled: ['11111111-1111-4111-8111-111111111111'] };
    expect(queueReadingPatch(settledCrash, 'article', { read: true }, '11111111-1111-4111-8111-111111111111', 1)).toBe(settledCrash);
    expect(settledCrash.outbox[0].key).toBe('newer');
  });

  it('keeps the gesture-visible CAS base when durable state advances while waiting for the lock', () => {
    const visible = { article: serverEntry({ fieldRevisions: { bookmarked: 0, read: 3, progress: 0, review: 0 } }) };
    const patch = { read: true } as const;
    const capturedBase = readingPatchBase(visible, 'article', patch);
    const advanced = {
      ...emptyReadingSyncStore(),
      entries: { article: serverEntry({ read: false, fieldRevisions: { bookmarked: 0, read: 10, progress: 0, review: 0 } }) },
    };
    const queued = queueReadingPatch(advanced, 'article', patch, '11111111-1111-4111-8111-111111111111', 1, capturedBase);
    expect(queued.outbox[0].base.read).toBe(3);
    expect(queued.entries.article.fieldRevisions.read).toBe(10);
  });

  it('fails closed and deterministically on divergent unsent copies sharing a UUID', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const left = queueReadingPatch(emptyReadingSyncStore(), 'left', { read: true }, id, 1);
    const right = queueReadingPatch(emptyReadingSyncStore(), 'right', { bookmarked: true }, id, 2);
    const leftRight = mergeReadingSyncStores(left, right);
    const rightLeft = mergeReadingSyncStores(right, left);
    expect(leftRight.integrityError).toBe(true);
    expect(rightLeft.integrityError).toBe(true);
    expect(leftRight.outbox).toEqual(rightLeft.outbox);
    expect(leftRight.outbox).toHaveLength(1);
  });

  it('reports an over-capacity durable model without evicting unsent intent from memory', () => {
    let store = emptyReadingSyncStore();
    for (let index = 0; index <= READING_SYNC_MAX_OUTBOX; index++) {
      const hex = index.toString(16).padStart(8, '0');
      store = queueReadingPatch(store, `article-${index}`, { read: true }, `${hex}-1111-4111-8111-111111111111`, index);
    }
    expect(store.outbox).toHaveLength(READING_SYNC_MAX_OUTBOX + 1);
    expect(readingSyncStoreFits(store)).toBe(false);
    expect(store.outbox.at(-1)?.key).toBe(`article-${READING_SYNC_MAX_OUTBOX}`);
  });

  it('rejects malformed or dangerous persisted queue content', () => {
    expect(parseReadingSyncStore(null)).toEqual(emptyReadingSyncStore());
    expect(parseReadingSyncStore('{bad')).toEqual(emptyReadingSyncStore());
    expect(parseReadingSyncStore(JSON.stringify({
      version: 1,
      revision: 2,
      migrated: true,
      entries: {},
      conflicts: [],
      outbox: [{ opId: 'not-a-uuid', key: '__proto__', base: {}, patch: { read: true }, sent: true, createdAt: 1 }],
    })).outbox).toEqual([]);
  });

  it('round-trips valid entries, operations, conflicts and sync time', () => {
    const operation = queueReadingPatch(emptyReadingSyncStore(), 'article', {
      bookmarked: true, read: true, progress: 33, reviewAction: 'enable',
    }, 'AAAAAAAA-1111-4111-8111-111111111111', 10).outbox[0];
    const value = {
      version: 1 as const,
      revision: 4,
      migrated: true,
      entries: {
        article: serverEntry({
          review: { enabled: true, step: 0, dueAt: '2026-10-27T00:00:00Z', lastReviewedAt: null },
        }),
      },
      outbox: [{ ...operation, sent: true }],
      conflicts: [{
        id: `${operation.opId}:read`, opId: operation.opId, key: 'article', field: 'read',
        desired: true, serverValue: false, serverRevision: 4,
      }],
      lastSyncedAt: 20,
    };
    expect(parseReadingSyncStore(JSON.stringify(value))).toEqual({
      ...value,
      outbox: [{ ...operation, opId: operation.opId.toLowerCase(), sent: true }],
      settled: [],
      resolvedConflicts: [],
    });
  });

  it.each([
    null, [], { version: 2, revision: 0, migrated: false, entries: {}, outbox: [], conflicts: [] },
    { version: 1, revision: -1, migrated: false, entries: {}, outbox: [], conflicts: [] },
    { version: 1, revision: 0, migrated: 'yes', entries: {}, outbox: [], conflicts: [] },
    { version: 1, revision: 0, migrated: false, entries: [], outbox: [], conflicts: [] },
    { version: 1, revision: 0, migrated: false, entries: {}, outbox: {}, conflicts: [] },
    { version: 1, revision: 0, migrated: false, entries: {}, outbox: [], conflicts: {} },
  ])('falls back for an invalid top-level model: %j', value => {
    expect(parseReadingSyncStore(JSON.stringify(value))).toEqual(emptyReadingSyncStore());
  });

  it('drops malformed nested records independently', () => {
    const malformedEntries = [
      1,
      { bookmarked: 'yes', read: false, progress: 0, updatedAt: 0, fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 0 } },
      { bookmarked: false, read: false, progress: -1, updatedAt: 0, fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 0 } },
      { bookmarked: false, read: false, progress: 0, updatedAt: -1, fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 0 } },
      { bookmarked: false, read: false, progress: 0, updatedAt: 0, fieldRevisions: { bookmarked: -1, read: 0, progress: 0, review: 0 } },
      { bookmarked: false, read: false, progress: 0, updatedAt: 0, fieldRevisions: { bookmarked: 0, read: 0, progress: 0, review: 0 }, review: { enabled: true, step: 8, dueAt: null, lastReviewedAt: null } },
    ];
    const parsed = parseReadingSyncStore(JSON.stringify({
      version: 1, revision: 0, migrated: true,
      entries: Object.fromEntries(malformedEntries.map((entry, index) => [`bad-${index}`, entry])),
      outbox: [
        null,
        { opId: '11111111-1111-4111-8111-111111111111', key: 'article', base: {}, patch: { extra: true }, sent: false, createdAt: 1 },
        { opId: '11111111-1111-4111-8111-111111111111', key: 'article', base: {}, patch: { read: 'yes' }, sent: false, createdAt: 1 },
        { opId: '11111111-1111-4111-8111-111111111111', key: 'article', base: { read: 0, extra: 0 }, patch: { read: true }, sent: false, createdAt: 1 },
      ],
      conflicts: [null, { id: 'x', opId: 'x', key: 'article', field: 'bad', desired: {}, serverRevision: -1 }],
      lastSyncedAt: -1,
    }));
    expect(parsed.entries).toEqual({});
    expect(parsed.outbox).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.lastSyncedAt).toBeUndefined();
  });
});
