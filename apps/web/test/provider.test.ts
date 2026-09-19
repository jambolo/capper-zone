import { it, expect } from 'vitest';
import { parseSource, usableResults } from '../src/provider.ts';
import { currentSeason, validateGames } from '../src/contracts.ts';
import { config, game } from './helpers.ts';

it("matches Rust's deterministic byte order for simultaneous games", () => {
  const games = validateGames([game({ id: '2017_16_LA_TEN' }), game({ id: '2017_16_LAC_NYJ' })], config);
  expect(games.map((g) => g.id)).toEqual(['2017_16_LAC_NYJ', '2017_16_LA_TEN']);
});

const header = 'game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\n';
it('normalizes relocated teams, stores ties, excludes preseason, and preserves unplayed games', () => {
  const games = parseSource(
    header +
      'a,2002,REG,1,2002-09-01,13:00,SD,10,OAK,10,Neutral\nb,2002,REG,2,2002-09-08,,STL,,SEA,,Home\nc,2002,PRE,1,2002-08-01,13:00,SEA,7,SF,3,Home\n',
    config,
  );
  expect(games).toHaveLength(2);
  expect(games[0].away_team).toBe('LAC');
  expect(games[0].home_team).toBe('LV');
  expect(games[0].result).toBe('tie');
  expect(games[0].neutral).toBe(true);
  expect(games[1].away_team).toBe('LAR');
  expect(games[1].result).toBeNull();
});
it('rejects duplicate ids, unknown teams, bad dates, and incomplete score pairs', () => {
  expect(() => validateGames([game(), game()], config)).toThrow(/Duplicate/);
  expect(() => validateGames([game({ home_team: 'ZZZ' })], config)).toThrow(/teams/);
  expect(() => validateGames([game({ date: '2026-02-30' })], config)).toThrow();
  expect(() => parseSource(header + 'a,2002,REG,1,2002-09-01,13:00,SEA,10,SF,,Home\n', config)).toThrow(/one score/);
});
it('holds same-day CSV scores and respects Eastern midnight', () => {
  const g = game({ date: '2026-09-01' });
  expect(usableResults([g], config, new Date('2026-09-02T03:59:00Z'))).toHaveLength(0);
  expect(usableResults([g], config, new Date('2026-09-02T04:01:00Z'))).toHaveLength(1);
  expect(usableResults([game({ result: null })], config, new Date('2026-09-03T00:00:00Z'))).toHaveLength(0);
});
it('keeps January and February in the previous NFL season', () => {
  expect(currentSeason(config, new Date('2027-02-28T23:59:59Z'))).toBe(2026);
  expect(currentSeason(config, new Date('2027-03-01T00:00:00Z'))).toBe(2027);
});
it('accepts another league through the canonical JSON adapter', () => {
  const other = {
    ...config,
    id: 'example',
    source: {
      kind: 'canonical-json' as const,
      url: 'https://example.com/games.json',
    },
  };
  const games = parseSource(
    JSON.stringify({
      schema_version: 1,
      league: 'example',
      games: [game({ league: 'example' })],
    }),
    other,
  );
  expect(games[0].league).toBe('example');
});
