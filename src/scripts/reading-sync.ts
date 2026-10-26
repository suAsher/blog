import { ApiError, jsonRequest, requestJSON } from '../lib/documents';
import {
  applyReadingReviewAction,
  applyReadingSyncResponse,
  emptyReadingSyncStore,
  markOperationsSent,
  mergeReadingSyncStores,
  parseReadingSyncStore,
  queueReadingPatch,
  readingBatchRequest,
  readingPatchBase,
  readingSyncStoreFits,
  readingStateFromSyncStore,
  READING_SYNC_STORAGE_KEY,
  reconcileReadingSnapshot,
  resolveReadingConflict,
  selectOperationBatch,
  type ReadingOperationPatch,
  type ReadingOperationBase,
  type ReadingReviewAction,
  type ReadingSnapshot,
  type ReadingSyncResponse,
  type ReadingSyncStore,
  writeWithEpochGuard,
} from '../lib/reading-sync';
import { isSafeReadingKey, type ReadingEntry, type ReadingState } from '../lib/storage';
import {
  getState,
  patchEntry,
  replaceState,
  setReadingStateMutationHandler,
  type ReadingStateMutation,
} from './shared';

const POLL_MS = 30_000;
const PROGRESS_THROTTLE_MS = 10_000;
const MAX_AUTOMATIC_RETRIES = 5;
const MAX_RETRY_DELAY_MS = 30_000;
const DURABILITY_MESSAGE = '同步队列无法持久保存；请保持页面打开，并从书架导出阅读记录或释放浏览器存储后重试。';
const INTEGRITY_MESSAGE = '检测到冲突的同步队列副本；为避免覆盖服务器，已停止发送。请先从书架导出阅读记录，再退出并重新登录。';
const SYNC_TIMEOUT_MS = 15_000;
const JOURNAL_PREFIX = 'asher-reading-sync-journal-';
const LOGOUT_EPOCH_KEY = 'asher-reading-sync-logout-epoch';

interface JournalIntent { opId: string; key: string; patch: ReadingOperationPatch; base: ReadingOperationBase; createdAt: number }
interface JournalRecord extends JournalIntent { epoch: string | null }

function readLogoutEpoch(): string | null {
  try { return localStorage.getItem(LOGOUT_EPOCH_KEY); }
  catch { return null; }
}

const startupLogoutEpoch = readLogoutEpoch();

type SyncPhase = 'local' | 'offline' | 'syncing' | 'synced' | 'conflict' | 'unavailable' | 'error';

export interface ReadingSyncStatus {
  phase: SyncPhase;
  pending: number;
  conflicts: number;
  lastSyncedAt?: number;
  message?: string;
}

let storageUnavailable = false;
let store = readStore();
let initialized = false;
let stopped = false;
let flushing = false;
let refreshing = false;
let generation = 0;
let phase: SyncPhase = store.conflicts.length ? 'conflict' : store.outbox.length ? 'local' : 'local';
let statusMessage = storageUnavailable ? DURABILITY_MESSAGE : store.integrityError ? INTEGRITY_MESSAGE : '';
let durabilityFailed = storageUnavailable;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastProgressFlushAt = 0;
let journalCorrupt = false;
const retryCounts = new Map<string, number>();

function readStore(): ReadingSyncStore {
  try {
    return parseReadingSyncStore(globalThis.localStorage?.getItem(READING_SYNC_STORAGE_KEY) ?? null);
  } catch {
    storageUnavailable = true;
    return emptyReadingSyncStore();
  }
}

function writeStore(): boolean {
  try {
    if (!readingSyncStoreFits(store)) return false;
    globalThis.localStorage?.setItem(READING_SYNC_STORAGE_KEY, JSON.stringify(store));
    return Boolean(globalThis.localStorage);
  } catch {
    return false;
  }
}

async function withReadingLock<T>(name: string, task: () => Promise<T> | T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(`asher-reading-sync-${name}`, () => task());
  }
  return task();
}

async function mutateStore(mutator: (current: ReadingSyncStore) => ReadingSyncStore): Promise<ReadingSyncStore> {
  return withReadingLock('data', () => {
    if (readLogoutEpoch() !== startupLogoutEpoch) {
      stopped = true;
      return store;
    }
    store = mergeReadingSyncStores(store, readStore());
    store = mutator(store);
    if (store.integrityError) {
      phase = 'error';
      statusMessage = INTEGRITY_MESSAGE;
    }
    durabilityFailed = !writeStore();
    if (durabilityFailed) {
      phase = 'error';
      statusMessage = DURABILITY_MESSAGE;
    }
    return store;
  });
}

const commitStore = (): Promise<ReadingSyncStore> => mutateStore(current => current);

const createOperationId = (): string => crypto.randomUUID();
const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

function readJournal(key: string): JournalRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    const values = Array.isArray(value) ? value : [value];
    const currentEpoch = readLogoutEpoch();
    return values.filter((item): item is JournalRecord => {
      const valid = item && typeof item === 'object' && typeof item.opId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.opId) &&
        typeof item.key === 'string' && isSafeReadingKey(item.key) &&
        Number.isFinite(item.createdAt) && item.createdAt >= 0 && item.patch && typeof item.patch === 'object' &&
        item.base && typeof item.base === 'object' &&
        (typeof item.epoch === 'string' || item.epoch === null);
      if (!valid) journalCorrupt = true;
      return Boolean(valid) && item.epoch === currentEpoch;
    });
  } catch { journalCorrupt = true; return []; }
}

function journalKeys(): string[] {
  try { return Object.keys(localStorage).filter(key => key.startsWith(JOURNAL_PREFIX)); }
  catch { return []; }
}

function purgePrivateSyncStorage() {
  let failed = false;
  let keys: string[] = [];
  try { localStorage.setItem(LOGOUT_EPOCH_KEY, crypto.randomUUID()); }
  catch { failed = true; }
  try { keys = Object.keys(localStorage).filter(key => key.startsWith(JOURNAL_PREFIX)); }
  catch { failed = true; }
  for (const key of [READING_SYNC_STORAGE_KEY, ...keys]) {
    try { localStorage.removeItem(key); } catch { failed = true; }
  }
  if (failed) throw new Error('阅读同步私有数据未能完全清除。');
}

function appendJournal(intent: JournalIntent): boolean {
  try {
    if (journalKeys().length >= 256) return false;
    const key = `${JOURNAL_PREFIX}${intent.opId}`;
    const record: JournalRecord = { ...intent, epoch: startupLogoutEpoch };
    return writeWithEpochGuard(
      startupLogoutEpoch,
      readLogoutEpoch,
      () => localStorage.setItem(key, JSON.stringify(record)),
      () => localStorage.removeItem(key),
    );
  } catch { return false; }
}

function removeJournalIntent(opId: string) {
  try { localStorage.removeItem(`${JOURNAL_PREFIX}${opId}`); }
  catch { /* The durable queue already contains this intent. */ }
}

async function drainJournals() {
  const keys = journalKeys();
  const captured = new Map(keys.map(key => [key, readJournal(key)]));
  const intents = [...captured.values()].flat().sort((a, b) => a.createdAt - b.createdAt || a.opId.localeCompare(b.opId));
  if (journalCorrupt) {
    durabilityFailed = true; phase = 'error'; statusMessage = DURABILITY_MESSAGE; renderStatus();
  }
  if (!intents.length) return;
  await mutateStore(current => intents.reduce((next, intent) =>
    queueReadingPatch(next, intent.key, intent.patch, intent.opId, intent.createdAt, intent.base), current));
  if (!durabilityFailed) {
    for (const [key, rows] of captured) {
      if (!rows.length) continue;
      try { localStorage.removeItem(key); } catch { /* Retrying is safe. */ }
    }
  }
}

function currentStatus(): ReadingSyncStatus {
  return {
    phase: durabilityFailed || journalCorrupt || store.integrityError ? 'error' : store.conflicts.length ? 'conflict' : !online() ? 'offline' : phase,
    pending: store.outbox.length,
    conflicts: store.conflicts.length,
    ...(store.lastSyncedAt !== undefined ? { lastSyncedAt: store.lastSyncedAt } : {}),
    ...(store.integrityError ? { message: INTEGRITY_MESSAGE } : journalCorrupt ? { message: DURABILITY_MESSAGE } : statusMessage ? { message: statusMessage } : {}),
  };
}

function formatLastSync(value: number | undefined): string {
  if (value === undefined) return '尚未与服务器同步';
  return `上次同步 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value)}`;
}

function renderConflicts(container: HTMLElement) {
  container.replaceChildren(...store.conflicts.map(conflict => {
    const row = document.createElement('div');
    row.className = 'reading-sync-conflict';
    const copy = document.createElement('p');
    copy.textContent = `${conflict.key} 的${conflict.field === 'review' ? '回顾计划' : conflict.field === 'progress' ? '阅读进度' : conflict.field === 'read' ? '已读状态' : '收藏状态'}在另一设备有更新。`;
    const actions = document.createElement('div');
    for (const [resolution, label] of [['server', '保留服务器'], ['reapply', '重新应用本机']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.syncConflict = conflict.id;
      button.dataset.syncResolution = resolution;
      button.textContent = label;
      actions.append(button);
    }
    row.append(copy, actions);
    return row;
  }));
}

function renderStatus() {
  const status = currentStatus();
  const root = document.getElementById('reading-sync-status');
  const indicator = document.getElementById('reading-sync-indicator');
  const label = document.getElementById('reading-sync-label');
  const detail = document.getElementById('reading-sync-detail');
  const conflicts = document.getElementById('reading-sync-conflicts');
  const labels: Record<SyncPhase, string> = {
    local: status.pending ? `${status.pending} 项等待同步` : '阅读记录保存在本机',
    offline: `离线 · ${status.pending} 项待同步`,
    syncing: `正在同步${status.pending ? ` · ${status.pending} 项` : ''}`,
    synced: '已跨设备同步',
    conflict: `${status.conflicts} 项需要选择`,
    unavailable: '服务器未启用阅读同步',
    error: `同步暂停${status.pending ? ` · ${status.pending} 项待处理` : ''}`,
  };
  if (root) root.dataset.syncPhase = status.phase;
  if (indicator) indicator.dataset.syncPhase = status.phase;
  if (label) label.textContent = labels[status.phase];
  if (detail) detail.textContent = status.message || formatLastSync(status.lastSyncedAt);
  if (conflicts) renderConflicts(conflicts);
  document.dispatchEvent(new CustomEvent<ReadingSyncStatus>('reading:sync-status', { detail: status }));
}

async function applyCanonical(_local: ReadingState, nextStore: ReadingSyncStore) {
  store = nextStore;
  const committed = await commitStore();
  replaceState(readingStateFromSyncStore(committed), { notifySync: false });
  renderStatus();
}

function changedPatch(mutation: ReadingStateMutation): ReadingOperationPatch {
  if (mutation.reviewAction) return { reviewAction: mutation.reviewAction };
  if (!mutation.key) return {};
  const before = mutation.previous[mutation.key];
  const after = mutation.next[mutation.key];
  if (!after) return {};
  return {
    ...(before?.bookmarked !== after.bookmarked ? { bookmarked: after.bookmarked } : {}),
    ...(before?.read !== after.read ? { read: after.read } : {}),
    ...(before?.progress !== after.progress ? { progress: after.progress } : {}),
  };
}

function replacementIntents(previous: ReadingState, next: ReadingState, now: number): JournalIntent[] {
  const intents: JournalIntent[] = [];
  for (const [key, entry] of Object.entries(next)) {
    const before = previous[key];
    const patch: ReadingOperationPatch = {
      ...(before?.bookmarked !== entry.bookmarked ? { bookmarked: entry.bookmarked } : {}),
      ...(before?.read !== entry.read ? { read: entry.read } : {}),
      ...(before?.progress !== entry.progress ? { progress: entry.progress } : {}),
    };
    if (Object.keys(patch).length) intents.push({
      opId: createOperationId(), key, patch, base: readingPatchBase(store.entries, key, patch), createdAt: now,
    });
    if (before?.review?.enabled !== entry.review?.enabled && entry.review) {
      const reviewPatch: ReadingOperationPatch = { reviewAction: entry.review.enabled ? 'enable' : 'disable' };
      intents.push({
        opId: createOperationId(), key, patch: reviewPatch,
        base: readingPatchBase(store.entries, key, reviewPatch), createdAt: now,
      });
    }
  }
  return intents;
}

function onLocalMutation(mutation: ReadingStateMutation) {
  const now = Date.now();
  const patch = changedPatch(mutation);
  const intents = mutation.key
    ? [{
        opId: createOperationId(), key: mutation.key, patch,
        base: readingPatchBase(store.entries, mutation.key, patch), createdAt: now,
      }]
    : replacementIntents(mutation.previous, mutation.next, now);
  const journaledIds = new Set(intents.filter(appendJournal).map(intent => intent.opId));
  if (intents.length && journaledIds.size !== intents.length) {
    durabilityFailed = true;
    phase = 'error';
    statusMessage = DURABILITY_MESSAGE;
  }
  if (!durabilityFailed) {
    phase = online() ? 'local' : 'offline';
    statusMessage = '';
  }
  renderStatus();
  const onlyProgress = mutation.key && !mutation.reviewAction && Object.keys(patch).every(key => key === 'progress');
  void mutateStore(current => intents.reduce((next, intent) =>
    queueReadingPatch(next, intent.key, intent.patch, intent.opId, intent.createdAt, intent.base), current)).then(() => {
    if (!durabilityFailed) journaledIds.forEach(removeJournalIntent);
    renderStatus();
    if (onlyProgress) scheduleProgressFlush();
    else void flushOutbox();
  });
}

function scheduleProgressFlush() {
  clearTimeout(progressTimer);
  const delay = Math.max(0, PROGRESS_THROTTLE_MS - (Date.now() - lastProgressFlushAt));
  progressTimer = setTimeout(() => void flushOutbox(), delay);
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function scheduleRetry(batchIds: string[]) {
  const attempt = Math.max(...batchIds.map(id => retryCounts.get(id) ?? 0), 0);
  if (attempt >= MAX_AUTOMATIC_RETRIES || !online()) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void flushOutbox(), retryDelay(attempt));
}

async function flushOutbox() {
  if (stopped || flushing || !online()) {
    phase = online() ? phase : 'offline';
    renderStatus();
    return;
  }
  flushing = true;
  let continueDraining = false;
  try {
    await withReadingLock('network', async () => {
      let batch: ReturnType<typeof selectOperationBatch> = [];
      await mutateStore(current => {
        if (current.integrityError) return current;
        batch = selectOperationBatch(current.outbox);
        return markOperationsSent(current, batch.map(operation => operation.opId));
      });
      if (store.integrityError) return;
      if (!batch.length) {
        phase = store.lastSyncedAt ? 'synced' : 'local';
        renderStatus();
        return;
      }
      const requestGeneration = generation;
      const ids = batch.map(operation => operation.opId);
      phase = 'syncing';
      if (!durabilityFailed) statusMessage = '';
      renderStatus();
      try {
        const response = await requestJSON<ReadingSyncResponse>('/api/reading-state', {
          ...jsonRequest('POST', readingBatchRequest(batch)), signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
        });
        if (requestGeneration !== generation) return;
        ids.forEach(id => retryCounts.delete(id));
        await commitStore();
        const result = applyReadingSyncResponse(getState(), store, response);
        await applyCanonical(result.local, result.store);
        lastProgressFlushAt = Date.now();
        phase = result.store.conflicts.length ? 'conflict' : result.store.outbox.length ? 'local' : 'synced';
        continueDraining = true;
      } catch (error) {
        if (requestGeneration !== generation) return;
        ids.forEach(id => retryCounts.set(id, (retryCounts.get(id) ?? 0) + 1));
        if (error instanceof ApiError && error.status === 404) {
          phase = 'unavailable';
          statusMessage = '本机记录仍会保存；服务器没有返回同步接口。';
        } else {
          phase = online() ? 'error' : 'offline';
          statusMessage = error instanceof Error ? error.message : '阅读同步暂时不可用。';
          scheduleRetry(ids);
        }
      }
    });
  } finally {
    flushing = false;
    await commitStore();
    renderStatus();
    if (continueDraining && phase !== 'unavailable' && store.outbox.length) void flushOutbox();
  }
}

export async function refreshReadingState() {
  if (stopped || refreshing || flushing || !online() || document.hidden) return;
  refreshing = true;
  try {
    await withReadingLock('network', async () => {
      await commitStore();
      const requestGeneration = generation;
      if (!store.lastSyncedAt) phase = 'syncing';
      renderStatus();
      try {
        const snapshot = await requestJSON<ReadingSnapshot>('/api/reading-state', { signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) });
        if (requestGeneration !== generation) return;
        await commitStore();
        const result = reconcileReadingSnapshot(getState(), store, snapshot, createOperationId, Date.now());
        await applyCanonical(result.local, result.store);
        phase = result.store.conflicts.length ? 'conflict' : result.store.outbox.length ? 'local' : 'synced';
        if (!durabilityFailed) statusMessage = '';
      } catch (error) {
        if (requestGeneration !== generation) return;
        if (error instanceof ApiError && error.status === 404) {
          phase = 'unavailable';
          statusMessage = '本机记录仍会保存；服务器没有返回同步接口。';
        } else {
          phase = online() ? 'error' : 'offline';
          statusMessage = error instanceof Error ? error.message : '阅读同步暂时不可用。';
        }
      }
    });
  } finally {
    refreshing = false;
    renderStatus();
  }
  if (store.outbox.length) void flushOutbox();
}

export function performReadingReview(key: string, action: ReadingReviewAction): boolean {
  const previous = getState()[key];
  const fallback: ReadingEntry = { bookmarked: false, read: false, progress: 0, updatedAt: 0 };
  const review = applyReadingReviewAction(previous?.review, action, Date.now());
  return patchEntry(key, { review }, action) && Boolean(previous ?? fallback);
}

function resolveConflictFromButton(button: HTMLElement) {
  const conflictId = button.dataset.syncConflict;
  const resolution = button.dataset.syncResolution;
  if (!conflictId || (resolution !== 'server' && resolution !== 'reapply')) return;
  const result = resolveReadingConflict(getState(), store, conflictId, resolution, createOperationId(), Date.now());
  void applyCanonical(result.local, result.store).then(() => {
    if (resolution === 'reapply') void flushOutbox();
  });
  phase = result.store.conflicts.length ? 'conflict' : result.store.outbox.length ? 'local' : 'synced';
}

function restartPolling() {
  clearInterval(pollTimer);
  pollTimer = undefined;
  if (document.hidden) return;
  pollTimer = setInterval(() => void refreshReadingState(), POLL_MS);
}

export function initReadingSync() {
  if (initialized) return;
  initialized = true;
  stopped = false;
  if (!navigator.locks) {
    stopped = true;
    phase = 'error';
    statusMessage = '此浏览器不支持安全的多标签同步；阅读记录将仅保存在本机。';
    document.addEventListener('auth:clear', event => {
      const detail = (event as CustomEvent<{ reason?: 'logout' | 'expired'; waitUntil?: (task: Promise<unknown>) => void }>).detail;
      if (detail?.reason !== 'logout') return;
      const cleanup = Promise.resolve().then(() => {
        purgePrivateSyncStorage();
      });
      detail.waitUntil?.(cleanup);
    });
    renderStatus();
    return;
  }
  setReadingStateMutationHandler(onLocalMutation);
  void drainJournals().then(() => flushOutbox());
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-sync-resolution],#reading-sync-retry') : null;
    if (!target) return;
    if (target.id === 'reading-sync-retry') {
      retryCounts.clear();
      statusMessage = '';
      void (store.outbox.length ? flushOutbox() : refreshReadingState());
    } else resolveConflictFromButton(target);
  });
  document.addEventListener('visibilitychange', () => {
    restartPolling();
    if (!document.hidden) void refreshReadingState();
  });
  window.addEventListener('focus', () => void refreshReadingState());
  window.addEventListener('online', () => { phase = 'local'; void flushOutbox().then(() => refreshReadingState()); });
  window.addEventListener('offline', () => { phase = 'offline'; renderStatus(); });
  window.addEventListener('storage', event => {
    if (event.key === LOGOUT_EPOCH_KEY && event.newValue !== startupLogoutEpoch) {
      generation++;
      stopped = true;
      return;
    }
    if (event.key !== READING_SYNC_STORAGE_KEY) return;
    if (event.newValue === null) {
      generation++;
      stopped = true;
      store = emptyReadingSyncStore();
    } else {
      store = mergeReadingSyncStores(store, parseReadingSyncStore(event.newValue));
      replaceState(readingStateFromSyncStore(store), { notifySync: false });
    }
    renderStatus();
  });
  document.addEventListener('auth:clear', event => {
    generation++;
    const detail = (event as CustomEvent<{ reason?: 'logout' | 'expired'; waitUntil?: (task: Promise<unknown>) => void }>).detail;
    stopped = true;
    clearTimeout(retryTimer);
    clearTimeout(progressTimer);
    clearInterval(pollTimer);
    const cleanup = detail?.reason === 'logout' ? withReadingLock('data', () => {
      purgePrivateSyncStorage();
      store = emptyReadingSyncStore();
      retryCounts.clear();
      phase = 'local';
      statusMessage = '';
      renderStatus();
    }) : commitStore();
    detail?.waitUntil?.(cleanup);
  });
  restartPolling();
  renderStatus();
  void refreshReadingState();
}
