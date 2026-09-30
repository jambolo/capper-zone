import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configSchema } from '../src/contracts.ts';
import { leagueIds } from '../src/leagues.ts';
import { loadLeagueConfigs, startupLeague } from '../src/selection.ts';

/** Reads `config/<id>.json` from the repository, as the published site serves it. */
const readPublished = async (url: string) => {
  const id = /\/([^/]+)\.json$/.exec(url)![1];
  return { config: configSchema.parse(JSON.parse(readFileSync(new URL(`../../../config/${id}.json`, import.meta.url), 'utf8'))) };
};

it('registers nfl and mlb in registry order', () => {
  expect(leagueIds).toEqual(['nfl', 'mlb']);
});

it('every registry league has a published configuration naming its id', async () => {
  const configs = await loadLeagueConfigs(leagueIds, 'https://site.test/config', readPublished);
  expect(configs.map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 'nfl', name: 'NFL' },
    { id: 'mlb', name: 'MLB' },
  ]);
});

it('picks the in-season registry league at startup when no hash or remembered league decides', async () => {
  const loadWindows = () => loadLeagueConfigs(leagueIds, 'https://site.test/config', readPublished);
  const startup = (today: string) => startupLeague({ ids: leagueIds, hash: '', store: null, today, loadWindows });
  expect(await startup('06-15')).toBe('mlb');
  expect(await startup('12-01')).toBe('nfl');
  expect(await startup('01-10')).toBe('nfl');
  expect(await startup('02-20')).toBe('mlb');
});
