import type { Store } from './storage.ts';

/** Small-key store key of the league the reader last switched to. */
export const rememberedLeagueKey = 'game-results-prediction:league';

const prefix = 'game-results-prediction:';
const attemptPattern = /^game-results-prediction:[a-zA-Z0-9-]+:last-attempt$/;

/** Browser localStorage for small keys only: refresh cooldowns and the remembered league.
 * Snapshots and current-season caches live in IndexedDB.
 */
export const smallStore = (): Store | null => {
  try {
    const probe = '__probe__';
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return {
      keys: () => Object.keys(localStorage),
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    };
  } catch {
    return null; // Private mode or blocked storage: run without persistent small keys.
  }
};

/** Deletes app entries earlier versions kept in the small store (snapshots, caches), keeping cooldowns,
 * the remembered league, and every key outside the app's prefix. Never throws.
 */
export function removeLegacyEntries(store: Store | null): void {
  try {
    for (const key of store?.keys() ?? []) {
      if (!key.startsWith(prefix) || key === rememberedLeagueKey || attemptPattern.test(key)) continue;
      try {
        store!.removeItem(key);
      } catch {
        /* Leave an entry that cannot be removed. */
      }
    }
  } catch {
    /* Storage is unavailable; nothing to clean up. */
  }
}
