import {
  isSafeReadingKey,
  type ReadingEntry,
  type ReadingReview,
  type ReadingState,
} from './storage';

export const READING_SYNC_STORAGE_KEY = 'asher-reading-sync-v1';
export const READING_SYNC_MAX_BATCH = 32;
export const READING_SYNC_MAX_BYTES = 32 * 1024;
export const READING_SYNC_MAX_OUTBOX = 1024;
export const READING_SYNC_MAX_STORE_BYTES = 2_000_000;

export type ReadingField = 'bookmarked' | 'read' | 'progress' | 'review';
export type ReadingReviewAction = 'enable' | 'complete' | 'disable';
export type ReadingFieldRevisions = Record<ReadingField, number>;
export type ReadingOperationPatch = Partial<Pick<ReadingEntry, 'bookmarked' | 'read' | 'progress'>> & {
  reviewAction?: ReadingReviewAction;
};
export type ReadingOperationBase = Partial<ReadingFieldRevisions>;

export interface ReadingServerEntry extends ReadingEntry {
  fieldRevisions: ReadingFieldRevisions;
}

export interface ReadingOperation {
  opId: string;
  key: string;
  base: ReadingOperationBase;
  patch: ReadingOperationPatch;
  sent: boolean;
  createdAt: number;
}

export interface ReadingConflict {
  id: string;
  opId: string;
  key: string;
  field: ReadingField;
  desired: boolean | number | ReadingReviewAction;
  serverValue: boolean | number | ReadingReview | undefined;
  serverRevision: number;
}

export interface ReadingSyncStore {
  version: 1;
  revision: number;
  migrated: boolean;
  entries: Record<string, ReadingServerEntry>;
  outbox: ReadingOperation[];
  conflicts: ReadingConflict[];
  settled: string[];
  resolvedConflicts: string[];
  integrityError?: boolean;
  lastSyncedAt?: number;
}

export interface ReadingSnapshot {
  revision: number;
  entries: Record<string, ReadingServerEntry>;
}

export interface ReadingSyncResult {
  opId: string;
  key: string;
  applied: string[];
  conflicts: string[];
  entry: ReadingServerEntry;
}

export interface ReadingSyncResponse {
  revision: number;
  results: ReadingSyncResult[];
}

export interface ReadingReconciliation {
  local: ReadingState;
  store: ReadingSyncStore;
}

const fields: ReadingField[] = ['bookmarked', 'read', 'progress', 'review'];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const validDate = (value: unknown): value is string | null =>
  value === null || typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

export function emptyReadingSyncStore(): ReadingSyncStore {
  return {
    version: 1, revision: 0, migrated: false, entries: {}, outbox: [], conflicts: [],
    settled: [], resolvedConflicts: [],
  };
}

export function readingSyncStoreFits(store: ReadingSyncStore): boolean {
  return store.outbox.length <= READING_SYNC_MAX_OUTBOX &&
    new TextEncoder().encode(JSON.stringify(store)).byteLength <= READING_SYNC_MAX_STORE_BYTES;
}

function parseReview(value: unknown): ReadingReview | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Number.isInteger(value.step) ||
      (value.step as number) < 0 || (value.step as number) > 3 ||
      !validDate(value.dueAt) || !validDate(value.lastReviewedAt)) return undefined;
  return {
    enabled: value.enabled,
    step: value.step as number,
    dueAt: value.dueAt,
    lastReviewedAt: value.lastReviewedAt,
  };
}

function parseRevisions(value: unknown): ReadingFieldRevisions | undefined {
  if (!isRecord(value) || !fields.every(field => isRevision(value[field]))) return undefined;
  return Object.fromEntries(fields.map(field => [field, value[field]])) as unknown as ReadingFieldRevisions;
}

function parseServerEntry(value: unknown): ReadingServerEntry | undefined {
  if (!isRecord(value) || typeof value.bookmarked !== 'boolean' || typeof value.read !== 'boolean' ||
      typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100 ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return undefined;
  const fieldRevisions = parseRevisions(value.fieldRevisions);
  if (!fieldRevisions) return undefined;
  const review = value.review === undefined ? undefined : parseReview(value.review);
  if (value.review !== undefined && !review) return undefined;
  return {
    bookmarked: value.bookmarked,
    read: value.read,
    progress: value.progress,
    updatedAt: value.updatedAt,
    fieldRevisions,
    ...(review ? { review } : {}),
  };
}

function patchFields(patch: ReadingOperationPatch): ReadingField[] {
  return [
    ...(typeof patch.bookmarked === 'boolean' ? ['bookmarked' as const] : []),
    ...(typeof patch.read === 'boolean' ? ['read' as const] : []),
    ...(typeof patch.progress === 'number' && Number.isFinite(patch.progress) ? ['progress' as const] : []),
    ...(patch.reviewAction ? ['review' as const] : []),
  ];
}

function sanitizePatch(value: unknown): ReadingOperationPatch | undefined {
  if (!isRecord(value)) return undefined;
  const known = ['bookmarked', 'read', 'progress', 'reviewAction'];
  if (Object.keys(value).some(key => !known.includes(key))) return undefined;
  const patch: ReadingOperationPatch = {};
  if (typeof value.bookmarked === 'boolean') patch.bookmarked = value.bookmarked;
  else if (value.bookmarked !== undefined) return undefined;
  if (typeof value.read === 'boolean') patch.read = value.read;
  else if (value.read !== undefined) return undefined;
  if (typeof value.progress === 'number' && Number.isFinite(value.progress)) {
    patch.progress = Math.max(0, Math.min(100, value.progress));
  } else if (value.progress !== undefined) return undefined;
  if (['enable', 'complete', 'disable'].includes(String(value.reviewAction))) {
    patch.reviewAction = value.reviewAction as ReadingReviewAction;
  } else if (value.reviewAction !== undefined) return undefined;
  return patchFields(patch).length ? patch : undefined;
}

function sanitizeOperation(value: unknown): ReadingOperation | undefined {
  if (!isRecord(value) || typeof value.opId !== 'string' || !uuidPattern.test(value.opId) ||
      typeof value.key !== 'string' || !isSafeReadingKey(value.key) || typeof value.sent !== 'boolean' ||
      typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0) return undefined;
  const patch = sanitizePatch(value.patch);
  if (!patch || !isRecord(value.base)) return undefined;
  const base = value.base;
  const expected = patchFields(patch);
  if (Object.keys(base).length !== expected.length || !expected.every(field => isRevision(base[field]))) return undefined;
  return {
    opId: value.opId.toLowerCase(),
    key: value.key,
    base: Object.fromEntries(expected.map(field => [field, base[field]])),
    patch,
    sent: value.sent,
    createdAt: value.createdAt,
  };
}

function sanitizeConflict(value: unknown): ReadingConflict | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.opId !== 'string' ||
      typeof value.key !== 'string' || !isSafeReadingKey(value.key) || !fields.includes(value.field as ReadingField) ||
      !isRevision(value.serverRevision)) return undefined;
  const desired = value.desired;
  if (!['boolean', 'number', 'string'].includes(typeof desired)) return undefined;
  return value as unknown as ReadingConflict;
}

/** Persisted sync metadata is private and untrusted just like local reading JSON. */
export function parseReadingSyncStore(raw: string | null): ReadingSyncStore {
  if (!raw) return emptyReadingSyncStore();
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRevision(value.revision) ||
        typeof value.migrated !== 'boolean' || !isRecord(value.entries) ||
        !Array.isArray(value.outbox) || !Array.isArray(value.conflicts)) return emptyReadingSyncStore();
    const entries = Object.fromEntries(Object.entries(value.entries).flatMap(([key, entry]) => {
      const parsed = parseServerEntry(entry);
      return isSafeReadingKey(key) && parsed ? [[key, parsed]] : [];
    }));
    return {
      version: 1,
      revision: value.revision,
      migrated: value.migrated,
      entries,
      outbox: value.outbox.flatMap(item => {
        const parsed = sanitizeOperation(item);
        return parsed ? [parsed] : [];
      }),
      conflicts: value.conflicts.flatMap(item => {
        const parsed = sanitizeConflict(item);
        return parsed ? [parsed] : [];
      }),
      settled: Array.isArray(value.settled)
        ? value.settled.filter((item): item is string => typeof item === 'string' && uuidPattern.test(item)).slice(-512)
        : [],
      resolvedConflicts: Array.isArray(value.resolvedConflicts)
        ? value.resolvedConflicts.filter((item): item is string => typeof item === 'string' && item.length <= 80).slice(-512)
        : [],
      ...(value.integrityError === true ? { integrityError: true } : {}),
      ...(typeof value.lastSyncedAt === 'number' && Number.isFinite(value.lastSyncedAt) && value.lastSyncedAt >= 0
        ? { lastSyncedAt: value.lastSyncedAt } : {}),
    };
  } catch {
    return emptyReadingSyncStore();
  }
}

const recentUnique = (values: string[]): string[] => [...new Set(values)].slice(-512);

/** Merge is commutative for durable multi-tab state; tombstones prevent stale resurrection. */
export function mergeReadingSyncStores(left: ReadingSyncStore, right: ReadingSyncStore): ReadingSyncStore {
  const settled = recentUnique([...left.settled, ...right.settled]);
  const resolvedConflicts = recentUnique([...left.resolvedConflicts, ...right.resolvedConflicts]);
  const operations = new Map<string, ReadingOperation>();
  let integrityError = false;
  for (const operation of [...left.outbox, ...right.outbox]) {
    if (settled.includes(operation.opId)) continue;
    const previous = operations.get(operation.opId);
    if (!previous) {
      operations.set(operation.opId, operation);
      continue;
    }
    if (previous.sent || operation.sent) {
      const sentCopies = [previous, operation].filter(item => item.sent);
      const fingerprints = new Set([previous, operation].map(item => JSON.stringify(readingOperationRequest(item))));
      if (fingerprints.size > 1) integrityError = true;
      operations.set(operation.opId, sentCopies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0]);
      continue;
    }
    const previousIdentity = JSON.stringify({ key: previous.key, patch: previous.patch, createdAt: previous.createdAt });
    const operationIdentity = JSON.stringify({ key: operation.key, patch: operation.patch, createdAt: operation.createdAt });
    if (previousIdentity !== operationIdentity) {
      integrityError = true;
      operations.set(operation.opId, [previous, operation].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))[0]);
      continue;
    }
    const base = Object.fromEntries(Object.keys({ ...previous.base, ...operation.base }).map(field => [
      field, Math.max(previous.base[field as ReadingField] ?? 0, operation.base[field as ReadingField] ?? 0),
    ]));
    operations.set(operation.opId, { ...previous, base });
  }
  const conflicts = new Map<string, ReadingConflict>();
  for (const conflict of [...left.conflicts, ...right.conflicts]) {
    if (!resolvedConflicts.includes(conflict.id)) conflicts.set(conflict.id, conflict);
  }
  const entries = { ...left.entries };
  for (const [key, entry] of Object.entries(right.entries)) entries[key] = mergeServerEntry(entries[key], entry);
  return {
    version: 1,
    revision: Math.max(left.revision, right.revision),
    migrated: left.migrated || right.migrated,
    entries,
    outbox: [...operations.values()].sort((a, b) => a.createdAt - b.createdAt || a.opId.localeCompare(b.opId)),
    conflicts: [...conflicts.values()],
    settled,
    resolvedConflicts,
    ...((left.integrityError || right.integrityError || integrityError) ? { integrityError: true } : {}),
    ...((left.lastSyncedAt !== undefined || right.lastSyncedAt !== undefined)
      ? { lastSyncedAt: Math.max(left.lastSyncedAt ?? 0, right.lastSyncedAt ?? 0) } : {}),
  };
}

const defaultRevisions = (): ReadingFieldRevisions => ({ bookmarked: 0, read: 0, progress: 0, review: 0 });
const defaultServerEntry = (): ReadingServerEntry => ({
  bookmarked: false,
  read: false,
  progress: 0,
  updatedAt: 0,
  fieldRevisions: defaultRevisions(),
});

export function readingPatchBase(entries: Record<string, ReadingServerEntry>, key: string, patch: ReadingOperationPatch): ReadingOperationBase {
  const revisions = entries[key]?.fieldRevisions ?? defaultRevisions();
  return Object.fromEntries(patchFields(patch).map(field => [field, revisions[field]]));
}

export function queueReadingPatch(
  store: ReadingSyncStore,
  key: string,
  rawPatch: ReadingOperationPatch,
  opId: string,
  now: number,
  capturedBase?: ReadingOperationBase,
): ReadingSyncStore {
  const patch = sanitizePatch(rawPatch);
  if (!isSafeReadingKey(key) || !patch || !uuidPattern.test(opId) || !Number.isFinite(now) || now < 0) return store;
  const requiredFields = patchFields(patch);
  const base = capturedBase ?? readingPatchBase(store.entries, key, patch);
  if (Object.keys(base).length !== requiredFields.length || requiredFields.some(field => !isRevision(base[field]))) {
    return { ...store, integrityError: true };
  }
  const normalizedOpId = opId.toLowerCase();
  if (store.settled.includes(normalizedOpId)) return store;
  const existing = store.outbox.find(operation => operation.opId === normalizedOpId);
  if (existing) {
    const sameIntent = existing.key === key && existing.createdAt === now &&
      JSON.stringify(existing.patch) === JSON.stringify(patch);
    return sameIntent ? store : { ...store, integrityError: true };
  }
  const previous = store.outbox.at(-1);
  const canCoalesce = previous && !previous.sent && previous.key === key &&
    previous.patch.reviewAction === undefined && patch.reviewAction === undefined;
  if (canCoalesce) {
    const mergedPatch = { ...previous.patch, ...patch };
    const merged: ReadingOperation = {
      opId: normalizedOpId,
      key,
      base: { ...base, ...previous.base },
      patch: mergedPatch,
      sent: false,
      createdAt: now,
    };
    return {
      ...store,
      outbox: [...store.outbox.slice(0, -1), merged],
      settled: recentUnique([...store.settled, previous.opId]),
    };
  }
  const operation: ReadingOperation = {
    opId: normalizedOpId,
    key,
    base,
    patch,
    sent: false,
    createdAt: now,
  };
  return { ...store, outbox: [...store.outbox, operation] };
}

export function markOperationsSent(store: ReadingSyncStore, opIds: string[]): ReadingSyncStore {
  const selected = new Set(opIds);
  return {
    ...store,
    outbox: store.outbox.map(operation => selected.has(operation.opId) ? { ...operation, sent: true } : operation),
  };
}

export const readingOperationRequest = ({ opId, key, base, patch }: ReadingOperation) => ({ opId, key, base, patch });
export const readingBatchRequest = (operations: ReadingOperation[]) => ({ operations: operations.map(readingOperationRequest) });

export function writeWithEpochGuard(
  expectedEpoch: string | null,
  readEpoch: () => string | null,
  write: () => void,
  rollback: () => void,
): boolean {
  if (readEpoch() !== expectedEpoch) return false;
  write();
  if (readEpoch() === expectedEpoch) return true;
  try { rollback(); } catch { /* Epoch-stamped payload remains ineligible for replay. */ }
  return false;
}

export function selectOperationBatch(outbox: ReadingOperation[]): ReadingOperation[] {
  const batch: ReadingOperation[] = [];
  const retrying = outbox.some(operation => operation.sent);
  const selectedKeys = new Set<string>();
  for (const operation of outbox) {
    if (operation.sent !== retrying || selectedKeys.has(operation.key)) continue;
    const candidate = [...batch, operation];
    const bytes = new TextEncoder().encode(JSON.stringify(readingBatchRequest(candidate))).byteLength;
    if (candidate.length > READING_SYNC_MAX_BATCH || bytes > READING_SYNC_MAX_BYTES) break;
    batch.push(operation);
    selectedKeys.add(operation.key);
  }
  return batch;
}

function localEntry(entry: ReadingServerEntry): ReadingEntry {
  const { fieldRevisions: _fieldRevisions, ...local } = entry;
  return local;
}

export function applyReadingReviewAction(previous: ReadingReview | undefined, action: ReadingReviewAction, now: number): ReadingReview {
  const iso = new Date(now).toISOString();
  if (action === 'disable') return { enabled: false, step: previous?.step ?? 0, dueAt: null, lastReviewedAt: previous?.lastReviewedAt ?? null };
  if (action === 'enable') return { enabled: true, step: 0, dueAt: new Date(now + 86_400_000).toISOString(), lastReviewedAt: previous?.lastReviewedAt ?? null };
  const step = Math.min(3, (previous?.step ?? 0) + 1);
  const days = [1, 3, 7, 30][step] ?? 30;
  return { enabled: true, step, dueAt: new Date(now + days * 86_400_000).toISOString(), lastReviewedAt: iso };
}

function overlayOperations(entries: Record<string, ReadingServerEntry>, operations: ReadingOperation[]): ReadingState {
  let state: ReadingState = Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, localEntry(entry)]));
  for (const operation of operations) {
    const previous = state[operation.key] ?? localEntry(defaultServerEntry());
    const next: ReadingEntry = {
      ...previous,
      ...(operation.patch.bookmarked !== undefined ? { bookmarked: operation.patch.bookmarked } : {}),
      ...(operation.patch.read !== undefined ? { read: operation.patch.read } : {}),
      ...(operation.patch.progress !== undefined ? { progress: operation.patch.progress } : {}),
      ...(operation.patch.reviewAction ? { review: applyReadingReviewAction(previous.review, operation.patch.reviewAction, operation.createdAt) } : {}),
      updatedAt: Math.max(previous.updatedAt, operation.createdAt),
    };
    state = { ...state, [operation.key]: next };
  }
  return state;
}

function migrationPatch(local: ReadingEntry, server: ReadingServerEntry): ReadingOperationPatch {
  return {
    ...(server.fieldRevisions.bookmarked === 0 && local.bookmarked ? { bookmarked: true } : {}),
    ...(server.fieldRevisions.read === 0 && local.read ? { read: true } : {}),
    ...(server.fieldRevisions.progress === 0 && local.progress > 0 ? { progress: local.progress } : {}),
  };
}

export function reconcileReadingSnapshot(
  local: ReadingState,
  store: ReadingSyncStore,
  snapshot: ReadingSnapshot,
  createId: () => string,
  now: number,
): ReadingReconciliation {
  if (!isRevision(snapshot.revision) || snapshot.revision < store.revision) return { local, store };
  const entries = Object.fromEntries(Object.entries(snapshot.entries).flatMap(([key, value]) => {
    const parsed = parseServerEntry(value);
    return isSafeReadingKey(key) && parsed ? [[key, parsed]] : [];
  }));
  let next: ReadingSyncStore = { ...store, revision: snapshot.revision, entries, lastSyncedAt: now };
  if (!store.migrated) {
    for (const [key, localEntryValue] of Object.entries(local)) {
      const server = entries[key] ?? defaultServerEntry();
      const patch = migrationPatch(localEntryValue, server);
      if (patchFields(patch).length) next = queueReadingPatch(next, key, patch, createId(), now);
      if (server.fieldRevisions.review === 0 && localEntryValue.review?.enabled) {
        next = queueReadingPatch(next, key, { reviewAction: 'enable' }, createId(), now);
      }
    }
    next = { ...next, migrated: true };
  }
  return { local: overlayOperations(next.entries, next.outbox), store: next };
}

function mergeServerEntry(previous: ReadingServerEntry | undefined, incoming: ReadingServerEntry): ReadingServerEntry {
  if (!previous) return incoming;
  const merged: ReadingServerEntry = { ...previous, updatedAt: Math.max(previous.updatedAt, incoming.updatedAt) };
  for (const field of fields) {
    if (incoming.fieldRevisions[field] < previous.fieldRevisions[field]) continue;
    merged.fieldRevisions = { ...merged.fieldRevisions, [field]: incoming.fieldRevisions[field] };
    if (field === 'review') {
      if (incoming.review) merged.review = incoming.review;
      else delete merged.review;
    } else if (field === 'bookmarked') merged.bookmarked = incoming.bookmarked;
    else if (field === 'read') merged.read = incoming.read;
    else merged.progress = incoming.progress;
  }
  return merged;
}

function desiredValue(operation: ReadingOperation, field: ReadingField): boolean | number | ReadingReviewAction | undefined {
  return field === 'review' ? operation.patch.reviewAction : operation.patch[field];
}

function serverValue(entry: ReadingServerEntry, field: ReadingField): boolean | number | ReadingReview | undefined {
  return field === 'review' ? entry.review : entry[field];
}

export function applyReadingSyncResponse(
  _local: ReadingState,
  store: ReadingSyncStore,
  response: ReadingSyncResponse,
  now = Date.now(),
): ReadingReconciliation {
  let entries = { ...store.entries };
  let outbox = [...store.outbox];
  let conflicts = [...store.conflicts];
  let settled = [...store.settled];
  for (const result of response.results) {
    const operationIndex = outbox.findIndex(item => item.opId === result.opId);
    const operation = outbox[operationIndex];
    const parsed = parseServerEntry(result.entry);
    if (!operation || !parsed || operation.key !== result.key) continue;
    entries = { ...entries, [result.key]: mergeServerEntry(entries[result.key], parsed) };
    const applied = result.applied.filter((field): field is ReadingField => fields.includes(field as ReadingField));
    outbox = outbox.map((item, index) => {
      if (index <= operationIndex || item.sent || item.key !== result.key) return item;
      const base = { ...item.base };
      for (const field of applied) {
        if (desiredValue(item, field) !== undefined) base[field] = Math.max(base[field] ?? 0, parsed.fieldRevisions[field]);
      }
      return { ...item, base };
    });
    for (const rawField of result.conflicts) {
      const field = rawField as ReadingField;
      const desired = fields.includes(field) ? desiredValue(operation, field) : undefined;
      if (desired === undefined) continue;
      const conflict: ReadingConflict = {
        id: `${operation.opId}:${field}`,
        opId: operation.opId,
        key: operation.key,
        field,
        desired,
        serverValue: serverValue(parsed, field),
        serverRevision: parsed.fieldRevisions[field],
      };
      conflicts = [...conflicts.filter(item => item.id !== conflict.id), conflict];
    }
    outbox = outbox.filter(item => item.opId !== operation.opId);
    settled = recentUnique([...settled, operation.opId]);
  }
  const next = {
    ...store,
    revision: Math.max(store.revision, response.revision),
    entries,
    outbox,
    conflicts,
    settled,
    lastSyncedAt: now,
  };
  return { local: overlayOperations(next.entries, next.outbox), store: next };
}

export const readingStateFromSyncStore = (store: ReadingSyncStore): ReadingState =>
  overlayOperations(store.entries, store.outbox);

export function resolveReadingConflict(
  local: ReadingState,
  store: ReadingSyncStore,
  conflictId: string,
  resolution: 'server' | 'reapply',
  opId: string,
  now: number,
): ReadingReconciliation {
  const conflict = store.conflicts.find(item => item.id === conflictId);
  if (!conflict) return { local, store };
  let next: ReadingSyncStore = {
    ...store,
    conflicts: store.conflicts.filter(item => item.id !== conflictId),
    resolvedConflicts: recentUnique([...store.resolvedConflicts, conflictId]),
  };
  if (resolution === 'reapply') {
    const patch: ReadingOperationPatch = conflict.field === 'review'
      ? { reviewAction: conflict.desired as ReadingReviewAction }
      : { [conflict.field]: conflict.desired };
    const normalizedOpId = opId.toLowerCase();
    if (uuidPattern.test(normalizedOpId) && Number.isFinite(now) && now >= 0) {
      if (next.settled.includes(normalizedOpId) || next.outbox.some(operation => operation.opId === normalizedOpId)) {
        return { local: overlayOperations(next.entries, next.outbox), store: { ...next, integrityError: true } };
      }
      const pendingIndex = conflict.field === 'review' ? -1 : next.outbox.findLastIndex(operation =>
        !operation.sent && operation.key === conflict.key && desiredValue(operation, conflict.field) !== undefined &&
        operation.patch.reviewAction === undefined);
      if (pendingIndex >= 0) {
        const pending = next.outbox[pendingIndex];
        const replacement: ReadingOperation = {
          opId: normalizedOpId,
          key: conflict.key,
          patch: { ...pending.patch, ...patch },
          base: { ...pending.base, [conflict.field]: conflict.serverRevision },
          sent: false,
          createdAt: now,
        };
        next = {
          ...next,
          outbox: next.outbox.map((operation, index) => index === pendingIndex ? replacement : operation),
          settled: recentUnique([...next.settled, pending.opId]),
        };
      } else {
        const operation: ReadingOperation = {
          opId: normalizedOpId,
          key: conflict.key,
          patch,
          base: { [conflict.field]: conflict.serverRevision },
          sent: false,
          createdAt: now,
        };
        next = { ...next, outbox: [...next.outbox, operation] };
      }
    }
  }
  return { local: overlayOperations(next.entries, next.outbox), store: next };
}
