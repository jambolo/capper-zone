import { afterEach, expect, it, vi } from 'vitest';
import { rememberedLeagueKey, removeLegacyEntries, smallStore } from '../src/small-store.ts';
import { memoryStore, type Store } from '../src/storage.ts';

afterEach(() => vi.unstubAllGlobals());

/** A localStorage stand-in: methods on the prototype, items as own properties, so Object.keys lists the items. */
class FakeLocalStorage {
  private get items() {
    return this as unknown as Record<string, string>;
  }
  getItem(key: string): string | null {
    return Object.hasOwn(this, key) ? this.items[key] : null;
  }
  setItem(key: string, value: string) {
    this.items[key] = value;
  }
  removeItem(key: string) {
    delete this.items[key];
  }
}

it('uses the remembered-league key game-results-prediction:league', () => {
  expect(rememberedLeagueKey).toBe('game-results-prediction:league');
});

it('removes legacy snapshot and cache entries and keeps cooldowns, the remembered league, and other keys', () => {
  const store = memoryStore();
  const kept = {
    'game-results-prediction:nfl:last-attempt': '1',
    'game-results-prediction:mlb:last-attempt': '2',
    'game-results-prediction:league': 'mlb',
    unrelated: 'value',
    'other-app:game-results-prediction:nfl:model-v1': 'foreign',
  };
  const removed = {
    'game-results-prediction:nfl:model-v1': 'nfl snapshot',
    'game-results-prediction:nfl:current-2025': 'nfl 2025 games',
    'game-results-prediction:nfl:current-2026': 'nfl 2026 games',
    'game-results-prediction:mlb:model-v1': 'mlb snapshot',
    'game-results-prediction:mlb:current-2026': 'mlb 2026 games',
    'game-results-prediction:model-v1': 'pre-league snapshot',
    'game-results-prediction:current-2025': 'pre-league games',
    'game-results-prediction:nfl:last-attempt:x': 'not a cooldown',
    'game-results-prediction:league:old': 'not the remembered league',
  };
  for (const [key, value] of Object.entries({ ...kept, ...removed })) store.setItem(key, value);
  removeLegacyEntries(store);
  expect(Object.fromEntries(store.keys().map((key) => [key, store.getItem(key)]))).toEqual(kept);
});

it('never throws when storage is missing or failing', () => {
  expect(() => removeLegacyEntries(null)).not.toThrow();
  const keysFail: Store = {
    ...memoryStore(),
    keys: () => {
      throw new Error('denied');
    },
  };
  expect(() => removeLegacyEntries(keysFail)).not.toThrow();
  const store = memoryStore();
  store.setItem('game-results-prediction:nfl:model-v1', 'a');
  store.setItem('game-results-prediction:mlb:model-v1', 'b');
  const removeFails: Store = {
    ...store,
    removeItem: (key) => {
      if (key.includes(':nfl:')) throw new Error('denied');
      store.removeItem(key);
    },
  };
  expect(() => removeLegacyEntries(removeFails)).not.toThrow();
  expect(store.keys()).toEqual(['game-results-prediction:nfl:model-v1']);
});

it('smallStore wraps localStorage and returns null when it is unavailable', () => {
  const storage = new FakeLocalStorage();
  vi.stubGlobal('localStorage', storage);
  const store = smallStore()!;
  expect(store).not.toBeNull();
  expect(Object.keys(storage)).toEqual([]);
  store.setItem(rememberedLeagueKey, 'nfl');
  expect(store.getItem(rememberedLeagueKey)).toBe('nfl');
  expect(store.keys()).toEqual([rememberedLeagueKey]);
  expect(storage.getItem(rememberedLeagueKey)).toBe('nfl');
  store.removeItem(rememberedLeagueKey);
  expect(Object.keys(storage)).toEqual([]);
  vi.stubGlobal('localStorage', {
    setItem: () => {
      throw new Error('blocked');
    },
  });
  expect(smallStore()).toBeNull();
});
