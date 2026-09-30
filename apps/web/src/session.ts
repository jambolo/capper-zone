import type { Posterior } from './model.ts';
import { indexedDbPersistence, type Persistence } from './persistence.ts';
import { message, type PublicState, type RefreshPhase } from './service.ts';
import { smallStore } from './small-store.ts';
import { readSnapshot, snapshotKey } from './snapshot.ts';
import { isCurrentCacheKey, memoryStore, type Store } from './storage.ts';
import type { RefreshMessage, RefreshRequest } from './refresh-worker.ts';

export const cooldownMs = 60_000;
/** Storage key of a league's last refresh attempt time. */
export const attemptKey = (league: string) => `game-results-prediction:${league}:last-attempt`;
/** Web Locks name that serializes a league's refreshes across tabs. */
export const lockName = (league: string) => `game-results-prediction:${league}:refresh`;
export type SessionView = {
  state: PublicState | null;
  model: Posterior | null;
  phase: RefreshPhase | 'waiting' | 'idle';
  retryAt: number | null;
  error: string;
};

// Also suppress duplicate mounts when persistent storage is unavailable.
const lastAttempts = new Map<string, number>();

export function startSession(options: {
  league: string;
  /** Base URL of the published league configuration files. */
  configBase: string;
  dataBase: string;
  onChange: (view: SessionView) => void;
  /** Small-key store for the refresh cooldown; defaults to `smallStore()`. */
  store?: Store | null;
  /** Snapshot and current-season cache persistence; defaults to IndexedDB. */
  persistence?: Persistence | null;
  createWorker?: () => Worker;
  locks?: Pick<LockManager, 'request'> | null;
}): () => void {
  const { league } = options;
  const configUrl = `${options.configBase.replace(/\/$/, '')}/${league}.json`;
  const store = options.store === undefined ? smallStore() : options.store;
  const persistence = options.persistence === undefined ? indexedDbPersistence() : options.persistence;
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
  /** Only this league's snapshot and current-season caches are read, handed to the worker, or saved. */
  const own = (entries: Record<string, string>) =>
    Object.fromEntries(Object.entries(entries).filter(([key]) => key === snapshotKey(league) || isCurrentCacheKey(key, league)));
  const load = async (): Promise<Record<string, string>> => {
    try {
      return own((await persistence?.load(league)) ?? {});
    } catch {
      return {}; // Continue without persistent storage.
    }
  };
  const save = async (entries: Record<string, string>) => {
    if (!persistence || !Object.keys(entries).length) return;
    try {
      await persistence.save(entries);
    } catch {
      /* Keep the computed result when storage is full or disabled. */
    }
  };
  const restore = (entries: Record<string, string>) => {
    const saved = memoryStore();
    for (const [key, value] of Object.entries(entries)) saved.setItem(key, value);
    const snapshot = readSnapshot(saved, league);
    if (snapshot) emit({ state: { ...snapshot.state, cached: true }, model: snapshot.model });
  };
  const fail = (error: string) => {
    if (view.state?.status === 'ready') {
      emit({ phase: 'idle', state: { ...view.state, cached: true, warning: `Update failed. ${error}` } });
    } else emit({ phase: 'idle', error });
  };
  // Show the saved model while the first check waits for its turn.
  const restored = load().then(restore);

  const runWorker = (cache: Record<string, string>) =>
    new Promise<void>((resolve) => {
      let saving: Promise<void> = Promise.resolve();
      const finish = () => {
        worker?.terminate();
        worker = null;
        finishWorker = null;
        // Hold the lock until the results are saved, so a waiting tab reloads them.
        void saving.then(resolve);
      };
      finishWorker = finish;
      try {
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
            saving = save(own(result.cache));
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
        worker.postMessage({ league, configUrl, dataBase: options.dataBase, cache } satisfies RefreshRequest);
      } catch (e) {
        fail(message(e));
        finish();
      }
    });

  const check = async () => {
    if (abort.signal.aborted) return;
    // A different tab may have completed its update while this tab waited for the lock.
    const cache = await load();
    if (abort.signal.aborted) return;
    restore(cache);
    const now = Date.now();
    let previous = lastAttempts.get(league) ?? 0;
    try {
      const persisted = Number(store?.getItem(attemptKey(league)));
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
    lastAttempts.set(league, now);
    try {
      store?.setItem(attemptKey(league), String(now));
    } catch {
      /* The in-memory guard still applies. */
    }
    emit({ phase: 'checking', retryAt: null, error: '' });
    await runWorker(cache);
  };
  const run = async () => {
    try {
      await restored;
      if (locks) await locks.request(lockName(league), { signal: abort.signal }, check);
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
