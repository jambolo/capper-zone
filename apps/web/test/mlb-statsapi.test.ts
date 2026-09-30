import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { adapterFor, isSourceKind } from '../src/adapters/index.ts';
import { mlbStatsApi } from '../src/adapters/mlb-statsapi.ts';
import { configSchema, validateGames, type Game } from '../src/contracts.ts';
import { parseSource } from '../src/provider.ts';

const rawConfig = () =>
  JSON.parse(readFileSync(new URL('../../../config/mlb.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const config = configSchema.parse(rawConfig());
const fixture = JSON.parse(
  readFileSync(new URL('../../../crates/rating-core/tests/fixtures/mlb-statsapi.json', import.meta.url), 'utf8'),
) as { league: string; documents: unknown[]; expected: Record<string, unknown>[] };
/** Each fixture document re-serialized to one JSON string, in array order. */
const documents = fixture.documents.map((document) => JSON.stringify(document));
const rustKeys = [
  'id',
  'league',
  'season',
  'start_time_utc',
  'phase',
  'round_label',
  'round',
  'home_team',
  'away_team',
  'home_source_id',
  'away_source_id',
  'neutral',
  'result',
] as const;
const project = (game: Game) => Object.fromEntries(rustKeys.map((key) => [key, game[key]]));

/** One schedule entry; an omitted score or tie flag omits the key, as the API does. */
function entry(
  gamePk: number,
  gameType: string,
  detailedState: string,
  home: [number, number?],
  away: [number, number?],
  isTie?: boolean,
  extra: Record<string, unknown> = {},
) {
  const side = ([id, score]: [number, number?]) => ({ team: { id, name: 'Team' }, ...(score === undefined ? {} : { score }) });
  return {
    gamePk,
    gameType,
    season: '2025',
    gameDate: '2025-10-25T00:08:00Z',
    officialDate: '2025-10-24',
    status: { abstractGameState: 'Final', codedGameState: 'F', detailedState, statusCode: 'F', startTimeTBD: false },
    teams: { away: side(away), home: side(home) },
    ...(isTie === undefined ? {} : { isTie }),
    ...extra,
  };
}
const document = (entries: unknown[]) => JSON.stringify({ dates: [{ date: '2025-10-24', games: entries }] });
const parseEntries = (entries: unknown[]) => parseSource([document(entries)], config);

it('parses the shared fixture exactly like the Rust adapter', () => {
  expect(fixture.league).toBe('mlb');
  expect(parseSource(documents, config).map(project)).toEqual(fixture.expected);
});

it('dates each game by its official date and keeps the provider start time', () => {
  const games = parseSource(documents, config);
  const byId = (id: string) => games.find((g) => g.id === id)!;
  expect(byId('776907')).toMatchObject({ date: '2025-08-02', start_time_utc: '2025-08-03T17:05:00Z' });
  expect(byId('813024')).toMatchObject({ date: '2025-11-01', start_time_utc: '2025-11-02T00:00:00Z' });
  expect(byId('900013')).toMatchObject({ date: '2004-06-01', start_time_utc: '2004-06-02T02:05:00Z' });
  expect(byId('900005')).toMatchObject({ date: '2026-05-15', start_time_utc: '2026-05-16T17:10:00Z', result: null });
  expect(games.every((g) => g.time === null && g.timezone === 'UTC' && !g.neutral)).toBe(true);
});

it('drops excluded, early, unplayed, and scoreless listings', () => {
  const ids = parseSource(documents, config).map((g) => g.id);
  for (const id of ['449187', '449246', '4207', '900001', '900002', '900003']) expect(ids).not.toContain(id);
  expect(parseEntries([entry(910010, 'R', 'Final', [141, 3], [119, 2], false, { season: '1997' })])).toEqual([]);
  expect(parseSource([], config)).toEqual([]);
  expect(parseSource([JSON.stringify({}), JSON.stringify({ dates: [{ date: '2025-10-24' }] })], config)).toEqual([]);
});

it('rejects an unknown game type', () => {
  expect(() => parseEntries([entry(910002, 'X', 'Final', [141, 3], [119, 2], false)])).toThrowError(/^Unknown game type: X$/);
});

it('rejects a season that is not an integer', () => {
  expect(() => parseEntries([entry(910011, 'R', 'Final', [141, 3], [119, 2], false, { season: '20x5' })])).toThrowError(
    /^Invalid season "20x5" for game 910011$/,
  );
});

it('rejects a tie flag that contradicts the scores', () => {
  expect(() => parseEntries([entry(910003, 'R', 'Final', [141, 2], [119, 2], false)])).toThrowError(
    /^Inconsistent tie flag for game 910003$/,
  );
  expect(() => parseEntries([entry(910004, 'R', 'Final', [141, 3], [119, 2], true)])).toThrowError(
    /^Inconsistent tie flag for game 910004$/,
  );
});

it('rejects conflicting final results', () => {
  expect(() =>
    parseEntries([entry(910005, 'R', 'Final', [141, 3], [119, 2], false), entry(910005, 'R', 'Final', [141, 4], [119, 2], false)]),
  ).toThrowError(/^Conflicting final results for game 910005$/);
});

it('rejects inconsistent listings of one game', () => {
  expect(() =>
    parseEntries([entry(910007, 'R', 'Scheduled', [141], [119]), entry(910007, 'R', 'Final', [147, 3], [119, 2], false)]),
  ).toThrowError(/^Inconsistent entries for game 910007$/);
});

it('rejects a malformed schedule document', () => {
  const malformed = /^Malformed MLB Stats API schedule document$/;
  expect(() => parseSource(['not json'], config)).toThrowError(malformed);
  expect(() =>
    parseSource([document([{ ...entry(910012, 'R', 'Final', [141, 3], [119, 2]), gamePk: '910012' }])], config),
  ).toThrowError(malformed);
  const { officialDate: _omitted, ...withoutOfficialDate } = entry(910013, 'R', 'Final', [141, 3], [119, 2]);
  expect(_omitted).toBe('2025-10-24');
  expect(() => parseEntries([withoutOfficialDate])).toThrowError(malformed);
});

it('rejects an invalid or offset-less gameDate only for listings that survive the status filter', () => {
  expect(() =>
    parseEntries([entry(910008, 'R', 'Final', [141, 3], [119, 2], false, { gameDate: '2025-10-25T00:08:00' })]),
  ).toThrowError(/^Invalid gameDate "2025-10-25T00:08:00" for game 910008$/);
  expect(() => parseEntries([entry(910009, 'R', 'Scheduled', [141], [119], undefined, { gameDate: 'soon' })])).toThrowError(
    /^Invalid gameDate "soon" for game 910009$/,
  );
  expect(parseEntries([entry(910014, 'R', 'Postponed', [141], [119], undefined, { gameDate: 'soon' })])).toEqual([]);
});

it('normalizes offset gameDates to UTC and keeps the later listing of equal instants', () => {
  const [game] = parseEntries([
    entry(910015, 'R', 'Final', [141, 3], [119, 2], false, { gameDate: '2025-10-25T00:08:00Z', officialDate: '2025-10-24' }),
    entry(910015, 'R', 'Final', [141, 3], [119, 2], false, { gameDate: '2025-10-24T20:08:00-04:00', officialDate: '2025-10-23' }),
  ]);
  expect(game).toMatchObject({ id: '910015', start_time_utc: '2025-10-25T00:08:00Z', date: '2025-10-23', result: 'home_win' });
});

it('resolves {season} in the season URL', () => {
  expect(mlbStatsApi.seasonUrls(config, 2026)).toEqual([
    'https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=2026&gameType=R,F,D,L,W',
  ]);
});

it('registers the mlb-statsapi kind with its result policy and flags', () => {
  expect(isSourceKind('mlb-statsapi')).toBe(true);
  expect(adapterFor(config)).toBe(mlbStatsApi);
  expect(mlbStatsApi).toMatchObject({ kind: 'mlb-statsapi', strictSourceIds: true, sourceStartTimes: true });
  expect(mlbStatsApi.resultPolicy).toEqual({
    summary: 'Results enter the picture as soon as the provider marks a game final.',
    detail: 'Results count as soon as the provider marks a game final; postponed, suspended, and cancelled games are not results.',
  });
});

it('accepts config/mlb.json', () => {
  expect(configSchema.safeParse(rawConfig()).success).toBe(true);
});

it('rejects an MLB source URL without a {season} placeholder', () => {
  const result = configSchema.safeParse({
    ...rawConfig(),
    source: { kind: 'mlb-statsapi', url: 'https://statsapi.mlb.com/api/v1/schedule?sportId=1' },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.message)).toContain('Source URL needs a {season} placeholder');
});

it('requires an abbreviation for every MLB team era', () => {
  const raw = rawConfig() as { teams: { eras: { abbreviation?: string }[] }[] };
  delete raw.teams[0].eras[0].abbreviation;
  const result = configSchema.safeParse(raw);
  expect(result.success).toBe(false);
  expect(result.error?.issues.map((issue) => issue.message)).toContain('Every team era needs an abbreviation');
});

it('requires a provider start time for adapters that supply them', () => {
  const [game] = parseEntries([entry(910016, 'R', 'Final', [141, 3], [119, 2], false)]);
  const { start_time_utc: _dropped, ...withoutStart } = game;
  expect(_dropped).toBe('2025-10-25T00:08:00Z');
  expect(() => validateGames([withoutStart], config)).toThrowError(/^Missing start time for 910016$/);
});

it('drops an unfinished postseason game that lists an unconfigured placeholder team', () => {
  // 2710 and 5528 are provider placeholders (e.g. "Higher Seed League Champion", "HOU/CWS"), absent from config aliases.
  const games = parseEntries([
    entry(910020, 'F', 'Scheduled', [2710], [147]),
    entry(910021, 'D', 'Pre-Game', [141], [5528]),
    entry(910022, 'L', 'Scheduled', [2710], [5528]),
    entry(910023, 'W', 'Warmup', [5528], [119]),
    entry(910024, 'D', 'Final', [147, 3], [141, 2], false),
    entry(910025, 'L', 'Scheduled', [119], [111]),
    entry(910026, 'R', 'Scheduled', [111], [147]),
  ]);
  expect(games.map((g) => [g.id, g.round_label, g.result])).toEqual([
    ['910024', 'D', 'home_win'],
    ['910025', 'L', null],
    ['910026', 'R', null],
  ]);
});

it('still rejects an unconfigured team on a final postseason game or an unfinished regular-season game', () => {
  expect(() => parseEntries([entry(910027, 'D', 'Final', [2710, 3], [147, 2], false)])).toThrowError(
    /^Invalid league or teams for 910027$/,
  );
  expect(() => parseEntries([entry(910028, 'R', 'Scheduled', [2710], [147])])).toThrowError(/^Invalid league or teams for 910028$/);
  expect(() =>
    parseEntries([entry(910029, 'W', 'Scheduled', [2710], [147]), entry(910029, 'W', 'Scheduled', [5528], [147])]),
  ).toThrowError(/^Inconsistent entries for game 910029$/);
});
