import type { Posterior } from './model.ts';
import { message, type PublicState, type RefreshPhase } from './service.ts';
import { readSnapshot, snapshotKey } from './snapshot.ts';
import { browserStore, type Store } from './storage.ts';
import type { RefreshMessage, RefreshRequest } from './refresh-worker.ts';

export const cooldownMs = 60_000;
export const attemptKey = 'game-results-prediction:nfl:last-attempt';
const lockKey = 'game-results-prediction:nfl:refresh';
export type SessionView = {
  state: PublicState | null;
  model: Posterior | null;
  phase: RefreshPhase | 'waiting' | 'idle';
  retryAt: number | null;
  error: string;
};

// Also suppress duplicate mounts when persistent storage is unavailable.
let lastAttempt = 0;

export function startSession(options: {
  configUrl: string;
  dataBase: string;
  onChange: (view: SessionView) => void;
  store?: Store | null;
  createWorker?: () => Worker;
  locks?: Pick<LockManager, 'request'> | null;
}): () => void {
  const store = options.store === undefined ? browserStore() : options.store;
  const locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
  const abort = new AbortController();
  let worker: Worker | null = null;
  let finishWorker: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let view: SessionView = { state: null, model: null, phase: 'checking', retryAt: null, error: '' };
  const emit = (update: Partial<SessionView>) => {
    if (abort.signal.aborted) return;
    view = { ...view, ...update };
    options.onChange(view);
  };
  const restore = () => {
    const snapshot = readSnapshot(store);
    if (snapshot) emit({ state: { ...snapshot.state, cached: true }, model: snapshot.model });
  };
  const fail = (error: string) => {
    if (view.state?.status === 'ready') {
      emit({ phase: 'idle', state: { ...view.state, cached: true, warning: `Update failed. ${error}` } });
    } else emit({ phase: 'idle', error });
  };
  restore();

  const runWorker = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        worker?.terminate();
        worker = null;
        finishWorker = null;
        resolve();
      };
      finishWorker = finish;
      try {
        const cache: Record<string, string> = {};
        try {
          for (const key of store?.keys() ?? []) {
            if (key === snapshotKey || /^game-results-prediction:[^:]+:current-\d+$/.test(key)) {
              const value = store!.getItem(key);
              if (value !== null) cache[key] = value;
            }
          }
        } catch {
          /* Continue without persistent storage. */
        }
        worker = options.createWorker?.() ?? new Worker(new URL('./refresh.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<RefreshMessage>) => {
          if (abort.signal.aborted) return;
          const result = event.data;
          if (result.type === 'progress') {
            emit({ phase: result.phase });
            return;
          }
          if (result.type === 'error') fail(result.error);
          else {
            try {
              for (const [key, value] of Object.entries(result.cache)) store?.setItem(key, value);
            } catch {
              /* Keep the computed result when storage is full or disabled. */
            }
            if (result.state.status === 'error' && view.state?.status === 'ready') {
              fail(result.state.error ?? 'The background update could not finish.');
            } else emit({ state: result.state, model: result.model, phase: 'idle', error: '' });
          }
          finish();
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(event.message || 'The background update could not finish.');
          finish();
        };
        worker.onmessageerror = () => {
          fail('The background update returned an unreadable result.');
          finish();
        };
        worker.postMessage({ configUrl: options.configUrl, dataBase: options.dataBase, cache } satisfies RefreshRequest);
      } catch (e) {
        fail(message(e));
        finish();
      }
    });

  const check = async () => {
    if (abort.signal.aborted) return;
    // A different tab may have completed its update while this tab waited for the lock.
    restore();
    const now = Date.now();
    let previous = lastAttempt;
    try {
      const persisted = Number(store?.getItem(attemptKey));
      if (Number.isFinite(persisted)) previous = Math.max(previous, persisted);
    } catch {
      /* Use the current page's cooldown if storage is unavailable. */
    }
    if (previous > now) previous = 0;
    const delay = previous > 0 ? Math.min(cooldownMs, Math.max(0, previous + cooldownMs - now)) : 0;
    if (delay > 0) {
      emit({ phase: 'waiting', retryAt: now + delay });
      timer = setTimeout(() => void run(), delay);
      return;
    }
    lastAttempt = now;
    try {
      store?.setItem(attemptKey, String(now));
    } catch {
      /* The in-memory guard still applies. */
    }
    emit({ phase: 'checking', retryAt: null, error: '' });
    await runWorker();
  };
  const run = async () => {
    try {
      if (locks) await locks.request(lockKey, { signal: abort.signal }, check);
      else await check();
    } catch (e) {
      if (!abort.signal.aborted) fail(message(e));
    }
  };
  // Let React finish its development-mode mount/cleanup cycle before recording an attempt.
  timer = setTimeout(() => void run(), 0);
  return () => {
    abort.abort();
    clearTimeout(timer);
    finishWorker?.();
  };
}
