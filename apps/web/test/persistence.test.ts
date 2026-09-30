import { afterEach, expect, it, vi } from 'vitest';
import { indexedDbPersistence } from '../src/persistence.ts';
import { snapshotKey } from '../src/snapshot.ts';
import { currentCacheKey } from '../src/storage.ts';
import { fakeIndexedDb } from './fake-indexeddb.ts';

afterEach(() => vi.unstubAllGlobals());

const entries = {
  [snapshotKey('nfl')]: 'nfl model',
  [currentCacheKey('nfl', 2025)]: 'nfl 2025 games',
  [currentCacheKey('nfl', 2026)]: 'nfl 2026 games',
  [snapshotKey('mlb')]: 'mlb model',
  [currentCacheKey('mlb', 2026)]: 'mlb 2026 games',
  [currentCacheKey('nfl-x', 2026)]: 'prefixed league games',
  'game-results-prediction:nfl:current-x': 'malformed season',
  'game-results-prediction:nfl:last-attempt': '1',
};

it('creates database game-results-prediction version 1 with one entries object store on first use', async () => {
  const idb = fakeIndexedDb();
  const persistence = indexedDbPersistence(idb.factory);
  expect(idb.calls.open).toBe(0);
  await persistence.save({ [snapshotKey('nfl')]: 'nfl model' });
  await persistence.load('nfl');
  expect(idb.calls).toEqual({ open: 1, upgrades: 1 });
  const db = idb.databases.get('game-results-prediction')!;
  expect(db.version).toBe(1);
  expect([...db.stores.keys()]).toEqual(['entries']);
  await indexedDbPersistence(idb.factory).load('nfl');
  expect(idb.calls).toEqual({ open: 2, upgrades: 1 });
});

it("saves entries and loads only the requested league's snapshot and current-season caches", async () => {
  const idb = fakeIndexedDb();
  const persistence = indexedDbPersistence(idb.factory);
  await persistence.save(entries);
  expect(idb.contents()).toEqual(entries);
  expect(await persistence.load('nfl')).toEqual({
    [snapshotKey('nfl')]: 'nfl model',
    [currentCacheKey('nfl', 2025)]: 'nfl 2025 games',
    [currentCacheKey('nfl', 2026)]: 'nfl 2026 games',
  });
  expect(await persistence.load('mlb')).toEqual({
    [snapshotKey('mlb')]: 'mlb model',
    [currentCacheKey('mlb', 2026)]: 'mlb 2026 games',
  });
  expect(await persistence.load('other')).toEqual({});
});

it("keeps every league's entries in one shared database across instances", async () => {
  const idb = fakeIndexedDb();
  const first = indexedDbPersistence(idb.factory);
  const second = indexedDbPersistence(idb.factory);
  await first.save({ [snapshotKey('nfl')]: 'nfl model' });
  await second.save({ [snapshotKey('mlb')]: 'mlb model' });
  await second.save({ [snapshotKey('nfl')]: 'nfl model 2' });
  expect(await first.load('nfl')).toEqual({ [snapshotKey('nfl')]: 'nfl model 2' });
  expect(await first.load('mlb')).toEqual({ [snapshotKey('mlb')]: 'mlb model' });
  expect(idb.contents()).toEqual({ [snapshotKey('nfl')]: 'nfl model 2', [snapshotKey('mlb')]: 'mlb model' });
});

it('behaves as no persistence when IndexedDB is missing, open throws, or open fails', async () => {
  const failing = [fakeIndexedDb({ openThrows: true }), fakeIndexedDb({ openFails: true })];
  for (const factory of [undefined, null, ...failing.map((idb) => idb.factory)]) {
    const persistence = indexedDbPersistence(factory);
    await expect(persistence.save({ [snapshotKey('nfl')]: 'nfl model' })).resolves.toBeUndefined();
    await expect(persistence.load('nfl')).resolves.toEqual({});
  }
  for (const idb of failing) expect(idb.contents()).toEqual({});
});

it('rejects a save whose transaction fails and keeps earlier entries', async () => {
  const idb = fakeIndexedDb();
  await indexedDbPersistence(idb.factory).save({ [snapshotKey('nfl')]: 'nfl model' });
  idb.databases.get('game-results-prediction')!.options.writesFail = true;
  const persistence = indexedDbPersistence(idb.factory);
  await expect(persistence.save({ [snapshotKey('nfl')]: 'replacement' })).rejects.toThrow('Quota exceeded');
  expect(await persistence.load('nfl')).toEqual({ [snapshotKey('nfl')]: 'nfl model' });
});

it('defaults to globalThis.indexedDB', async () => {
  await expect(indexedDbPersistence().load('nfl')).resolves.toEqual({});
  const idb = fakeIndexedDb();
  vi.stubGlobal('indexedDB', idb.factory);
  await indexedDbPersistence().save({ [snapshotKey('nfl')]: 'nfl model' });
  expect(idb.contents()).toEqual({ [snapshotKey('nfl')]: 'nfl model' });
});
