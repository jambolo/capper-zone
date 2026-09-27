import { afterEach, it, expect, vi } from 'vitest';
import { PredictionService } from '../src/service.ts';
import { fitPosterior, predict } from '../src/model.ts';
import { memoryStore, type Store } from '../src/storage.ts';
import { config, configHash, game, historyBytes, seed } from './helpers.ts';

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
  expect(a.getState().games[0]).toMatchObject({ round: 1, round_label: 'REG', start_time_utc: '2026-09-01T17:00:00Z' });
  expect(JSON.parse(store.getItem(cacheKey)!).schema_version).toBe(2);
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

it('keeps an obsolete cache until a successful refresh replaces it with the current format', async () => {
  publish();
  const store = memoryStore();
  await service(store, async () => csv).initialize();
  const old = JSON.parse(store.getItem(cacheKey)!);
  old.schema_version = 1;
  const saved = JSON.stringify(old);
  store.setItem(cacheKey, saved);
  const offline = service(store, () => Promise.reject(new Error('offline')));
  await offline.initialize();
  expect(offline.getState().status).toBe('error');
  expect(offline.getState().error).toContain('No valid current-season cache');
  expect(store.getItem(cacheKey)).toBe(saved);
  const refreshed = service(store, async () => csv);
  await refreshed.initialize();
  expect(refreshed.getState().status).toBe('ready');
  expect(refreshed.getState().warning).toContain('Replaced it with a valid download');
  expect(JSON.parse(store.getItem(cacheKey)!).schema_version).toBe(2);
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

it('preserves pregame predictions when the game itself, same-day games, or later results change', async () => {
  publish();
  const rows = [
    csv.split('\n')[0],
    'first,2026,REG,1,2026-09-01,13:00,SF,10,SEA,20,Home',
    'prior,2026,REG,2,2026-09-08,13:00,SF,10,SEA,20,Home',
    'early,2026,REG,3,2026-09-15,13:00,SF,30,SEA,10,Home',
    'target,2026,REG,3,2026-09-15,20:20,SF,30,SEA,10,Neutral',
    'simultaneous,2026,REG,3,2026-09-15,20:20,KC,30,SEA,10,Home',
    'late,2026,REG,3,2026-09-15,23:00,SF,30,SEA,10,Home',
    'later,2026,REG,3,2026-09-16,13:00,SF,30,SEA,10,Home',
    'awaiting,2026,REG,3,2026-09-19,13:00,SF,,SEA,,Home',
    'upcoming,2026,REG,4,2026-09-20,13:00,SF,,SEA,,Home',
  ];
  const source = rows.join('\n');
  const run = async (text: string, at = now()) => {
    const s = new PredictionService({
      config,
      configHash,
      dataBase,
      season: 2026,
      now: () => at,
      store: memoryStore(),
      fetchSource: async () => text,
    });
    await s.initialize();
    expect(s.getState().status).toBe('ready');
    return s;
  };
  const atKickoff = await run(source, new Date('2026-09-16T00:20:00Z'));
  const after = await run(source);
  const target = after.getState().games.find((g) => g.id === 'target')!;
  expect(target.status).toBe('completed');
  expect(target.prediction).toEqual(atKickoff.predict('SEA', 'SF', true, 'regular'));
  expect(after.getState().games[0].prediction).toEqual(predict(fitPosterior(seed(), [], config), 'SEA', 'SF', false, 'regular'));

  const corrected = await run(source.replaceAll(',30,SEA,10', ',10,SEA,30'));
  expect(corrected.getState().games.find((g) => g.id === 'target')!.result).toBe('home_win');
  expect(corrected.getState().games.find((g) => g.id === 'target')!.prediction).toEqual(target.prediction);
  expect(corrected.predict('SEA', 'SF', true, 'regular')).not.toEqual(after.predict('SEA', 'SF', true, 'regular'));
  const changedPrior = await run(
    source.replace('prior,2026,REG,2,2026-09-08,13:00,SF,10,SEA,20', 'prior,2026,REG,2,2026-09-08,13:00,SF,20,SEA,10'),
  );
  expect(changedPrior.getState().games.find((g) => g.id === 'target')!.prediction!.home_win).toBeLessThan(
    target.prediction!.home_win,
  );

  for (const id of ['awaiting', 'upcoming']) {
    expect(after.getState().games.find((g) => g.id === id)!.prediction).toEqual(after.predict('SEA', 'SF', false, 'regular'));
  }
});

it('uses earlier UTC dates for canonical results across timezones and respects postseason rules', async () => {
  publish();
  const prior = game({ id: 'prior', date: '2026-09-01', time: '12:00', timezone: 'UTC' });
  const s = new PredictionService({
    config: { ...config, source: { ...config.source, kind: 'canonical-json' } },
    configHash,
    dataBase,
    season: 2026,
    now,
    store: memoryStore(),
    fetchSource: async () =>
      JSON.stringify({
        schema_version: 2,
        league: 'nfl',
        games: [
          game({ id: 'later', date: '2026-09-02', time: '16:00', timezone: 'America/New_York', result: 'away_win' }),
          game({ id: 'target', date: '2026-09-02', time: '12:00', timezone: 'UTC', phase: 'postseason', neutral: false }),
          game({ id: 'same-utc-day', date: '2026-09-01', time: '23:30', timezone: 'America/Los_Angeles', result: 'away_win' }),
          prior,
        ],
      }),
  });
  await s.initialize();
  expect(s.getState().status).toBe('ready');
  const prediction = s.getState().games.find((g) => g.id === 'target')!.prediction;
  expect(prediction).toEqual(predict(fitPosterior(seed(), [prior], config), 'SEA', 'SF', false, 'postseason'));
  expect(prediction!.tie).toBe(0);
});
