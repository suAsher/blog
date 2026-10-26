export type PrivateSessionReason = 'logout' | 'expired';

export interface PrivateSessionCleanup {
  reason: PrivateSessionReason;
  /** Register durable cleanup during the synchronous event dispatch. */
  waitUntil: (task: Promise<unknown>) => void;
}

interface PendingCleanup {
  reason: PrivateSessionReason;
  completion: Promise<boolean>;
}
let pending: PendingCleanup | undefined;
let logoutIntent = false;

export const explicitLogoutInProgress = () => logoutIntent;
/** A failed server request leaves normal expiry navigation available again. */
export function releaseLogoutIntent(): void { logoutIntent = false; }

/** Lock private UI immediately and finish bounded cleanup before leaving it. */
export function clearPrivateSession(reason: PrivateSessionReason): Promise<boolean> {
  if (reason === 'logout') logoutIntent = true;
  if (typeof document === 'undefined') return Promise.resolve(true);
  if (pending && (pending.reason === 'logout' || reason === pending.reason)) return pending.completion;
  const previous = pending?.completion;
  let finish!: (success: boolean) => void;
  const run: PendingCleanup = {
    reason,
    completion: new Promise<boolean>(resolve => { finish = resolve; }),
  };
  // Publish this run before dispatch so nested/concurrent requests can join it.
  pending = run;
  const tasks: Promise<unknown>[] = [];
  if (previous) tasks.push(previous.then(success => {
    if (!success) throw new Error('An earlier device cleanup did not finish.');
  }));
  document.dispatchEvent(new CustomEvent<PrivateSessionCleanup>('auth:clear', {
    detail: { reason, waitUntil: task => tasks.push(Promise.resolve(task)) },
  }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  void Promise.race([
    Promise.allSettled(tasks).then(results => results.every(result => result.status === 'fulfilled')),
    new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 3000); }),
  ]).then(success => {
    clearTimeout(timeout);
    if (pending === run) pending = undefined;
    finish(success);
  });
  return run.completion;
}
