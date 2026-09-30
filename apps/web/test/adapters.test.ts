import { expect, it } from 'vitest';
import { adapterFor, isSourceKind } from '../src/adapters/index.ts';
import { canonicalJson } from '../src/adapters/canonical-json.ts';
import { nflverseCsv } from '../src/adapters/nflverse-csv.ts';
import { configSchema } from '../src/contracts.ts';
import { parseSource } from '../src/provider.ts';
import { config, configBytes, game } from './helpers.ts';

const header = 'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\n';
const csv = header + 'a,2002,REG,1,2002-09-01,13:00,SD,10,OAK,10,Neutral\n';

it('adapterFor throws for an unknown kind', () => {
  expect(() => adapterFor({ source: { kind: 'bogus', url: 'https://example.com/games.json' } })).toThrow('Unknown source adapter');
});

it('resolves both registered kinds', () => {
  expect(adapterFor({ source: { kind: 'nflverse-csv', url: 'https://example.com/a' } })).toBe(nflverseCsv);
  expect(adapterFor({ source: { kind: 'canonical-json', url: 'https://example.com/a' } })).toBe(canonicalJson);
  expect([isSourceKind('nflverse-csv'), isSourceKind('canonical-json'), isSourceKind('bogus')]).toEqual([true, true, false]);
});

it('configSchema rejects an unknown kind with the adapter message', () => {
  const raw = JSON.parse(configBytes.toString()) as Record<string, unknown>;
  const result = configSchema.safeParse({ ...raw, source: { kind: 'bogus', url: 'https://example.com/games.json' } });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((i) => i.message)).toContain('Unknown source adapter');
});

it('exposes source-id strictness and result-policy text', () => {
  expect(nflverseCsv.strictSourceIds).toBe(true);
  expect(canonicalJson.strictSourceIds).toBe(false);
  expect(nflverseCsv.resultPolicy).toEqual({
    summary: "Today's results enter the picture the next day, Eastern Time.",
    detail: 'Results from today are held until the next calendar day in Eastern Time because the source has no live/final flag.',
  });
  expect(canonicalJson.resultPolicy).toEqual({
    summary: 'Results enter the picture as soon as the provider reports them.',
    detail: 'The provider supplies completed game outcomes.',
  });
});

it('downloads one season from the configured source URL', () => {
  expect(nflverseCsv.seasonUrls(config, 2026)).toEqual([config.source.url]);
  expect(canonicalJson.seasonUrls(config, 2026)).toEqual([config.source.url]);
});

it('nflverse pregameDay uses the America/New_York date', () => {
  expect(nflverseCsv.pregameDay(game({ date: '2026-09-01', time: '23:30', timezone: 'America/Los_Angeles' }))).toBe('2026-09-02');
  expect(nflverseCsv.pregameDay(game({ date: '2026-09-01', time: '21:00', timezone: 'America/New_York' }))).toBe('2026-09-01');
  expect(nflverseCsv.pregameDay(game({ start_time_utc: '2026-09-02T03:59:00Z' }))).toBe('2026-09-01');
  expect(nflverseCsv.pregameDay(game({ start_time_utc: '2026-09-02T04:00:00Z' }))).toBe('2026-09-02');
});

it('canonical-json pregameDay uses the UTC date', () => {
  expect(canonicalJson.pregameDay(game({ date: '2026-09-01', time: '23:30', timezone: 'America/Los_Angeles' }))).toBe('2026-09-02');
  expect(canonicalJson.pregameDay(game({ date: '2026-09-01', time: '21:00', timezone: 'America/New_York' }))).toBe('2026-09-02');
  expect(canonicalJson.pregameDay(game({ start_time_utc: '2026-09-02T03:59:00Z' }))).toBe('2026-09-02');
});

it('nflverse holds results until the next local day; canonical-json results are eligible at once', () => {
  const g = game({ date: '2026-09-01' });
  expect(nflverseCsv.isResultEligible(g, new Date('2026-09-02T03:59:00Z'))).toBe(false);
  expect(nflverseCsv.isResultEligible(g, new Date('2026-09-02T04:01:00Z'))).toBe(true);
  expect(canonicalJson.isResultEligible(g, new Date('2026-09-01T17:00:00Z'))).toBe(true);
});

it('parse requires exactly one document', () => {
  const envelope = JSON.stringify({ schema_version: 2, league: 'nfl', games: [] });
  expect(() => nflverseCsv.parse([], config)).toThrow();
  expect(() => nflverseCsv.parse([csv, csv], config)).toThrow();
  expect(() => canonicalJson.parse([], config)).toThrow();
  expect(() => canonicalJson.parse([envelope, envelope], config)).toThrow();
  expect(canonicalJson.parse([envelope], config)).toEqual([]);
});

it('parseSource accepts one document as a string or an array', () => {
  expect(parseSource([csv], config)).toEqual(parseSource(csv, config));
  expect(parseSource([csv], config)).toMatchObject([{ id: 'a', away_team: 'LAC', home_team: 'LV', result: 'tie' }]);
});
