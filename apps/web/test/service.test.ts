import { afterEach, it, expect, vi } from 'vitest';
import { PredictionService } from '../src/service.ts';
import { memoryStore, type Store } from '../src/storage.ts';
import { config, configHash, historyBytes, seed } from './helpers.ts';

const now = () => new Date('2026-09-19T18:00:00Z');
const dataBase = 'https://published.test/data';
const csv =
  'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\ng1,2026,REG,1,2026-09-01,13:00,SF,10,SEA,20,Home\ng2,2026,REG,2,2026-09-20,13:00,KC,,SEA,,Home\n';
const cacheKey = 'game-results-prediction:nfl:current-2026';

/** Stands in for the published static assets the Rust programs generate. */
function publish(files: Record<string, string> = {}) {
  const published: Record<string, string> = {
    [`${dataBase}/nfl/history.json`]: historyBytes,
    [`${dataBase}/nfl/elo-2026.json`]: JSON.stringify(seed()),
    ...files,
  };
  const requests: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    const body = published[url];
    return Promise.resolve(
      body === undefined ? new Response('missing', { status: 404 }) : new Response(new TextEncoder().encode(body), { status: 200 }),
    );
  });
  return { published, requests };
}
const service = (store: Store, fetchSource: () => Promise<string>) =>
  new PredictionService({ config, configHash, dataBase, season: 2026, now, store, fetchSource });

afterEach(() => vi.unstubAllGlobals());

it('refreshes once per startup, uses each result once, and does not rewrite history or Elo', async () => {
  const { published, requests } = publish();
  const store = memoryStore();
  let sources = 0;
  const run = async () => {
    const s = service(store, async () => {
      sources++;
      return csv;
    });
    await s.initialize();
    return s;
  };
  const a = await run(),
    b = await run();
  expect(sources).toBe(2);
  expect(a.getState().status).toBe('ready');
  expect(a.getState().training_games).toBe(1);
  expect(a.predict('SEA', 'SF', true, 'regular')).toEqual(b.predict('SEA', 'SF', true, 'regular'));
  expect(requests.every((r) => r.method === 'GET')).toBe(true);
  expect(published[`${dataBase}/nfl/history.json`]).toBe(historyBytes);
  expect(JSON.parse(published[`${dataBase}/nfl/elo-2026.json`]!)).toEqual(seed());
});

it('falls back visibly to valid cached data without overwriting it', async () => {
  publish();
  const store = memoryStore();
  await service(store, async () => csv).initialize();
  const cached = store.getItem(cacheKey);
  const second = service(store, () => Promise.reject(new Error('offline')));
  await second.initialize();
  expect(second.getState().status).toBe('ready');
  expect(second.getState().cached).toBe(true);
  expect(second.getState().warning).toContain('offline');
  expect(store.getItem(cacheKey)).toBe(cached);
});

it('refuses stale seeds and future leakage while still refreshing the current cache', async () => {
  const stale = seed();
  stale.target_season = 2025;
  publish({ [`${dataBase}/nfl/elo-2026.json`]: JSON.stringify(stale) });
  const store = memoryStore();
  const s = service(store, async () => csv);
  await s.initialize();
  expect(s.getState().status).toBe('error');
  expect(s.getState().error).toContain('wrong league or season');
  expect(JSON.parse(store.getItem(cacheKey)!).games).toHaveLength(2);
});

it('reports missing published ratings instead of inventing predictions', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('missing', { status: 404 })));
  const s = service(memoryStore(), async () => csv);
  await s.initialize();
  expect(s.getState().status).toBe('error');
  expect(s.getState().error).toContain('initial ratings could not be loaded');
});

it('applies a corrected result by rebuilding, and rejects a truncated refresh', async () => {
  publish();
  const store = memoryStore();
  const run = async (text: string) => {
    const s = service(store, async () => text);
    await s.initialize();
    return s;
  };
  const first = await run(csv),
    corrected = await run(csv.replace('SF,10,SEA,20', 'SF,30,SEA,20'));
  expect(corrected.getState().cached).toBe(false);
  expect(corrected.predict('SEA', 'SF', true, 'regular').home_win).toBeLessThan(
    first.predict('SEA', 'SF', true, 'regular').home_win,
  );
  const truncated = await run(
    csv
      .split('\n')
      .filter((line) => !line.startsWith('g1,'))
      .join('\n'),
  );
  expect(truncated.getState().cached).toBe(true);
  expect(truncated.getState().warning).toContain('lost a previously completed');
});
