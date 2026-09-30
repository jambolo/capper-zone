import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { windowsSchema, type LeagueConfig } from '../src/contracts.ts';
import {
  defaultLeagueId,
  explicitLeague,
  hashChangeTarget,
  leagueFromHash,
  loadLeagueConfigs,
  localMonthDay,
  recordSwitch,
  rememberedLeague,
  startupLeague,
  type LeagueWindows,
} from '../src/selection.ts';
import { rememberedLeagueKey } from '../src/small-store.ts';
import { memoryStore, type Store } from '../src/storage.ts';

const ids = ['nfl', 'mlb'] as const;
const windowsOf = (id: string) =>
  windowsSchema.parse(JSON.parse(readFileSync(new URL(`../../../config/${id}.json`, import.meta.url), 'utf8')).windows);
/** The real configurations' windows, in registry order. */
const real: LeagueWindows[] = ids.map((id) => ({ id, windows: windowsOf(id) }));
const league = (id: string, season: [string, string], postseason: [string, string]): LeagueWindows => ({
  id,
  windows: { season: { start: season[0], end: season[1] }, postseason: { start: postseason[0], end: postseason[1] } },
});
const a = league('a', ['03-01', '06-30'], ['06-01', '06-30']);
const b = league('b', ['05-01', '10-31'], ['10-01', '10-31']);
const c = league('c', ['05-15', '09-30'], ['09-01', '09-30']);
const twin = (id: string) => league(id, ['04-01', '09-30'], ['09-01', '09-30']);
const withRemembered = (id: string | null): Store => {
  const store = memoryStore();
  if (id !== null) store.setItem(rememberedLeagueKey, id);
  return store;
};

it('default rule: exactly one league in season wins', () => {
  expect(defaultLeagueId([a, b], '03-15')).toBe('a');
  expect(defaultLeagueId([a, b], '07-15')).toBe('b');
});

it('default rule: several in season, the first in its postseason window wins', () => {
  expect(defaultLeagueId([a, b], '06-10')).toBe('a');
  expect(defaultLeagueId([b, c], '09-10')).toBe('c');
  expect(defaultLeagueId([b, c], '09-30')).toBe('c');
  expect(defaultLeagueId([a, b, c], '06-30')).toBe('a');
});

it('default rule: several in season, none in postseason, the fewest days to a postseason start wins', () => {
  expect(defaultLeagueId([a, b], '05-10')).toBe('a');
  expect(defaultLeagueId([b, c], '06-15')).toBe('c');
  expect(defaultLeagueId([c, b], '07-01')).toBe('c');
});

it('default rule: none in season, the fewest days to a season start wins', () => {
  expect(defaultLeagueId([b, c], '11-15')).toBe('b');
  expect(defaultLeagueId([a, b], '12-01')).toBe('a');
  expect(defaultLeagueId([a, b], '11-01')).toBe('a');
});

it('default rule: a season window that wraps the year boundary', () => {
  const winter = league('winter', ['09-01', '02-15'], ['01-08', '02-15']);
  expect(defaultLeagueId([winter, a], '01-10')).toBe('winter');
  expect(defaultLeagueId([a, winter], '12-31')).toBe('winter');
  expect(defaultLeagueId([winter, a], '02-15')).toBe('winter');
  expect(defaultLeagueId([winter, a], '02-16')).toBe('a');
  expect(defaultLeagueId(real, '01-10')).toBe('nfl');
});

it('default rule: identical windows fall back to registry order', () => {
  for (const today of ['05-01', '09-15', '12-01']) {
    expect(defaultLeagueId([twin('x'), twin('y')], today)).toBe('x');
    expect(defaultLeagueId([twin('y'), twin('x')], today)).toBe('y');
  }
  expect(defaultLeagueId([], '05-01')).toBeNull();
});

it.each([
  ['06-15', 'mlb'],
  ['12-01', 'nfl'],
  ['01-10', 'nfl'],
  ['02-15', 'nfl'],
  ['10-15', 'mlb'],
  ['09-15', 'mlb'],
  ['02-20', 'mlb'],
  ['02-29', 'mlb'],
])('default rule on the real configurations: %s -> %s', (today, expected) => {
  expect(defaultLeagueId(real, today)).toBe(expected);
});

it('reads the browser-local date as MM-DD and treats February 29 as February 28', () => {
  expect(localMonthDay(new Date(2026, 0, 5, 23, 59))).toBe('01-05');
  expect(localMonthDay(new Date(2026, 11, 31, 0, 1))).toBe('12-31');
  expect(localMonthDay(new Date(2028, 1, 29, 12))).toBe('02-28');
});

it('accepts only a hash that exactly names a registry id', () => {
  expect(leagueFromHash('#mlb', ids)).toBe('mlb');
  expect(leagueFromHash('#nfl', ids)).toBe('nfl');
  for (const hash of ['', '#', 'mlb', '#MLB', '#mlb ', '#/mlb', '#mlb?x', '#other']) expect(leagueFromHash(hash, ids)).toBeNull();
});

it('precedence: a valid hash beats the remembered league and the default rule', async () => {
  const loadWindows = vi.fn(async () => real);
  expect(await startupLeague({ ids, hash: '#nfl', store: withRemembered('mlb'), today: '06-15', loadWindows })).toBe('nfl');
  expect(explicitLeague(ids, '#nfl', withRemembered('mlb'))).toBe('nfl');
  expect(loadWindows).not.toHaveBeenCalled();
});

it('precedence: an invalid hash falls back to the remembered league', async () => {
  const loadWindows = vi.fn(async () => real);
  for (const hash of ['', '#', '#MLB', '#other'])
    expect(await startupLeague({ ids, hash, store: withRemembered('nfl'), today: '06-15', loadWindows })).toBe('nfl');
  expect(loadWindows).not.toHaveBeenCalled();
});

it('precedence: an unregistered or missing remembered league falls back to the default rule', async () => {
  const loadWindows = vi.fn(async () => real);
  for (const store of [withRemembered('other'), withRemembered('NFL'), withRemembered(null), null])
    expect(await startupLeague({ ids, hash: '#other', store, today: '06-15', loadWindows })).toBe('mlb');
  expect(loadWindows).toHaveBeenCalledTimes(4);
  expect(rememberedLeague(withRemembered('other'), ids)).toBeNull();
  const failing: Store = {
    ...memoryStore(),
    getItem: () => {
      throw new Error('denied');
    },
  };
  expect(await startupLeague({ ids, hash: '', store: failing, today: '12-01', loadWindows })).toBe('nfl');
});

it('precedence: the default rule uses loaded registry leagues in registry order and falls back to the first registry id', async () => {
  const reversed = async () => [twin('other'), twin('mlb'), twin('nfl')];
  expect(await startupLeague({ ids, hash: '', store: null, today: '05-01', loadWindows: reversed })).toBe('nfl');
  const onlyMlb = async () => real.filter((l) => l.id === 'mlb');
  expect(await startupLeague({ ids, hash: '', store: null, today: '12-01', loadWindows: onlyMlb })).toBe('mlb');
  const none = async () => [];
  expect(await startupLeague({ ids, hash: '', store: null, today: '06-15', loadWindows: none })).toBe('nfl');
  const failing = () => Promise.reject(new Error('offline'));
  expect(await startupLeague({ ids, hash: '', store: null, today: '06-15', loadWindows: failing })).toBe('nfl');
});

it('loads each registry configuration in parallel and leaves out failures', async () => {
  const configs: Record<string, Pick<LeagueConfig, 'id' | 'name' | 'windows'>> = {
    'https://test/config/nfl.json': { id: 'nfl', name: 'NFL', windows: windowsOf('nfl') },
    'https://test/config/mlb.json': { id: 'mlb', name: 'MLB', windows: windowsOf('mlb') },
  };
  const pending: string[] = [];
  const release = Promise.withResolvers<void>();
  const read = vi.fn(async (url: string) => {
    pending.push(url);
    await release.promise;
    if (!(url in configs)) throw new Error('Not published');
    return { config: configs[url] as LeagueConfig };
  });
  const loading = loadLeagueConfigs(['nfl', 'other', 'mlb'], 'https://test/config/', read);
  await Promise.resolve();
  expect(pending).toEqual(['https://test/config/nfl.json', 'https://test/config/other.json', 'https://test/config/mlb.json']);
  release.resolve();
  expect(await loading).toEqual([
    { id: 'nfl', name: 'NFL', windows: windowsOf('nfl') },
    { id: 'mlb', name: 'MLB', windows: windowsOf('mlb') },
  ]);
  const mismatched = async () => ({ config: configs['https://test/config/nfl.json'] as LeagueConfig });
  expect(await loadLeagueConfigs(['mlb'], 'https://test/config', mismatched)).toEqual([]);
});

it('switching sets the hash and the remembered league', () => {
  let hash = '#nfl';
  const writes: string[] = [];
  const location = {
    get hash() {
      return hash;
    },
    set hash(value: string) {
      writes.push(value);
      hash = value;
    },
  };
  const store = memoryStore();
  recordSwitch('mlb', { location, store });
  expect(writes).toEqual(['#mlb']);
  expect(store.getItem(rememberedLeagueKey)).toBe('mlb');
  recordSwitch('mlb', { location, store });
  expect(writes).toEqual(['#mlb']);
  const failing: Store = {
    ...memoryStore(),
    setItem: () => {
      throw new Error('denied');
    },
  };
  expect(() => recordSwitch('nfl', { location, store: failing })).not.toThrow();
  expect(() => recordSwitch('mlb', { location, store: null })).not.toThrow();
  expect(writes).toEqual(['#mlb', '#nfl', '#mlb']);
});

it('switches on a hashchange only to another registry league', () => {
  expect(hashChangeTarget('#mlb', 'nfl', ids)).toBe('mlb');
  expect(hashChangeTarget('#nfl', 'nfl', ids)).toBeNull();
  expect(hashChangeTarget('#MLB', 'nfl', ids)).toBeNull();
  expect(hashChangeTarget('', 'nfl', ids)).toBeNull();
});
