import { snapshotKey } from './snapshot.ts';
import { isCurrentCacheKey } from './storage.ts';

/** Page-side persistence of model snapshots and current-season caches, keyed by `snapshotKey(league)` and
 * `currentCacheKey(league, season)`; values are the JSON strings the refresh worker returns.
 */
export interface Persistence {
  /** The league's snapshot and current-season cache entries; empty when nothing is stored or persistence is unavailable. */
  load(league: string): Promise<Record<string, string>>;
  /** Stores every entry in one transaction; rejects when the write fails. Resolves without writing when unavailable. */
  save(entries: Record<string, string>): Promise<void>;
}

const databaseName = 'game-results-prediction';
const storeName = 'entries';

/** Opens the database, creating its object store on first use; null when IndexedDB is missing or fails to open. */
function open(factory: IDBFactory | null | undefined): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!factory) return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** Settles with the transaction: `value()` once it completes, the transaction error if it fails or aborts. */
function settle<T>(transaction: IDBTransaction, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(value());
    transaction.onerror = () => reject(transaction.error ?? new Error('Persistence transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Persistence transaction aborted'));
  });
}

/** IndexedDB persistence (database `game-results-prediction`, version 1, object store `entries`, out-of-line keys).
 * The database opens on first use; a missing factory or a failed open behaves as no persistence.
 */
export function indexedDbPersistence(factory: IDBFactory | null | undefined = globalThis.indexedDB): Persistence {
  let database: Promise<IDBDatabase | null> | null = null;
  const connect = () => (database ??= open(factory));
  return {
    async load(league) {
      const db = await connect();
      if (!db) return {};
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const entries: Record<string, string> = {};
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (typeof key !== 'string' || !(key === snapshotKey(league) || isCurrentCacheKey(key, league))) continue;
          const value = store.get(key);
          value.onsuccess = () => {
            if (typeof value.result === 'string') entries[key] = value.result;
          };
        }
      };
      return await settle(transaction, () => entries);
    },
    async save(entries) {
      const db = await connect();
      if (!db) return;
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const [key, value] of Object.entries(entries)) store.put(value, key);
      await settle(transaction, () => undefined);
    },
  };
}
