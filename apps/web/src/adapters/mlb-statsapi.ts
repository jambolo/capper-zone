import { DateTime } from 'luxon';
import { z } from 'zod';
import type { LeagueConfig } from '../contracts.ts';
import type { SourceAdapter } from './types.ts';

const side = z.object({
  team: z.object({ id: z.number().int().nonnegative() }),
  score: z.number().int().nonnegative().nullish(),
});
// Unknown fields are ignored; `dates` and `games` may be absent.
const scheduleSchema = z.object({
  dates: z
    .array(
      z.object({
        games: z
          .array(
            z.object({
              gamePk: z.number().int().nonnegative(),
              gameType: z.string(),
              season: z.string(),
              gameDate: z.string(),
              officialDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              status: z.object({ detailedState: z.string() }),
              teams: z.object({ home: side, away: side }),
              isTie: z.boolean().nullish(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});
type Entry = z.infer<typeof scheduleSchema>['dates'][number]['games'][number];
type Phase = 'regular' | 'postseason';

/** Phase and round per game type; null excludes spring training, exhibition, and All-Star games. */
const gameTypes = new Map<string, { phase: Phase; round: number } | null>([
  ['R', { phase: 'regular', round: 1 }],
  ['F', { phase: 'postseason', round: 2 }],
  ['D', { phase: 'postseason', round: 3 }],
  ['L', { phase: 'postseason', round: 4 }],
  ['W', { phase: 'postseason', round: 5 }],
  ['S', null],
  ['E', null],
  ['A', null],
]);
const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
/** Postseason game types whose undecided matchups the provider lists with placeholder teams. */
const placeholderTypes = new Set(['F', 'D', 'L', 'W']);

/** One schedule listing that survived the status filter. */
type Listing = {
  gamePk: number;
  gameType: string;
  phase: Phase;
  round: number;
  season: number;
  officialDate: string;
  /** Start instant in epoch milliseconds, and as normalized UTC text. */
  start: number;
  startUtc: string;
  home: number;
  away: number;
  final: { home: number; away: number; tie: boolean } | null;
};

/** Per-entry rules in the Rust adapter's order; null drops the entry. */
function listing(entry: Entry, config: LeagueConfig): Listing | null {
  const { gamePk } = entry;
  if (!gameTypes.has(entry.gameType)) throw new Error(`Unknown game type: ${entry.gameType}`);
  const type = gameTypes.get(entry.gameType);
  if (!type) return null;
  if (!/^[+-]?\d+$/.test(entry.season)) throw new Error(`Invalid season ${JSON.stringify(entry.season)} for game ${gamePk}`);
  const season = Number(entry.season);
  if (season < config.history_start) return null;
  // `abstractGameState` is "Final" for postponed and cancelled listings, so only the detailed text decides.
  const base = entry.status.detailedState.split(':')[0].trim();
  let final: Listing['final'] = null;
  if (['Postponed', 'Cancelled', 'Suspended'].includes(base)) return null;
  if (base === 'Final' || base === 'Completed Early') {
    const { home, away } = entry.teams;
    // A final listing without both scores is not a usable result.
    if (home.score == null || away.score == null) return null;
    final = { home: home.score, away: away.score, tie: entry.isTie === true };
  }
  const parsed = rfc3339.test(entry.gameDate)
    ? DateTime.fromISO(entry.gameDate.toUpperCase().replace(' ', 'T'), { zone: 'utc' })
    : null;
  if (!parsed?.isValid) throw new Error(`Invalid gameDate ${JSON.stringify(entry.gameDate)} for game ${gamePk}`);
  return {
    gamePk,
    gameType: entry.gameType,
    ...type,
    season,
    officialDate: entry.officialDate,
    start: parsed.toMillis(),
    startUtc: parsed.toISO({ suppressMilliseconds: true })!,
    home: entry.teams.home.team.id,
    away: entry.teams.away.team.id,
    final,
  };
}

/** Collapses every listing of one `gamePk` into a single game record; null drops an undecided postseason matchup. */
function game(listings: Listing[], config: LeagueConfig) {
  const [first] = listings;
  const { gamePk } = first;
  if (
    !listings.every(
      (l) => l.gameType === first.gameType && l.season === first.season && l.home === first.home && l.away === first.away,
    )
  )
    throw new Error(`Inconsistent entries for game ${gamePk}`);
  const finals = listings.filter((l) => l.final !== null);
  const [score] = finals.map((l) => l.final!);
  if (finals.some(({ final }) => final!.home !== score.home || final!.away !== score.away || final!.tie !== score.tie))
    throw new Error(`Conflicting final results for game ${gamePk}`);
  // `>=` keeps the last of equal instants, i.e. the later listing in input order.
  const latest = (finals.length ? finals : listings).reduce((best, l) => (l.start >= best.start ? l : best));
  let result: 'home_win' | 'away_win' | 'tie' | null = null;
  if (latest.final) {
    const { home, away, tie } = latest.final;
    if (tie && home === away) result = 'tie';
    else if (!tie && home > away) result = 'home_win';
    else if (!tie && away > home) result = 'away_win';
    else throw new Error(`Inconsistent tie flag for game ${gamePk}`);
  }
  const home = String(latest.home);
  const away = String(latest.away);
  // TS only (no Rust counterpart): an unplayed postseason game may list a placeholder such as "Higher Seed League
  // Champion" until its matchup is decided. Final games and regular-season games keep failing validation.
  if (
    result === null &&
    placeholderTypes.has(latest.gameType) &&
    !(Object.hasOwn(config.aliases, home) && Object.hasOwn(config.aliases, away))
  )
    return null;
  return {
    id: String(gamePk),
    league: config.id,
    season: latest.season,
    date: latest.officialDate,
    time: null,
    timezone: 'UTC',
    start_time_utc: latest.startUtc,
    phase: latest.phase,
    round_label: latest.gameType,
    round: latest.round,
    home_team: config.aliases[home] ?? home,
    away_team: config.aliases[away] ?? away,
    // Special venues, reversed home/away listings, and relocated games all stay home games.
    neutral: false,
    home_source_id: home,
    away_source_id: away,
    result,
  };
}

/** MLB Stats API schedule responses: one document per season, finality from the status text, one game per `gamePk`. */
export const mlbStatsApi: SourceAdapter = {
  kind: 'mlb-statsapi',
  strictSourceIds: true,
  sourceStartTimes: true,
  resultPolicy: {
    summary: 'Results enter the picture as soon as the provider marks a game final.',
    detail: 'Results count as soon as the provider marks a game final; postponed, suspended, and cancelled games are not results.',
  },
  validateConfig: (config) => (config.source.url.includes('{season}') ? null : 'Source URL needs a {season} placeholder'),
  seasonUrls: (config, season) => [config.source.url.replaceAll('{season}', String(season))],
  parse(documents, config) {
    const groups = new Map<number, Listing[]>();
    for (const document of documents) {
      let schedule: z.infer<typeof scheduleSchema>;
      try {
        schedule = scheduleSchema.parse(JSON.parse(document));
      } catch {
        throw new Error('Malformed MLB Stats API schedule document');
      }
      for (const date of schedule.dates) {
        for (const entry of date.games) {
          const l = listing(entry, config);
          if (!l) continue;
          const group = groups.get(l.gamePk);
          if (group) group.push(l);
          else groups.set(l.gamePk, [l]);
        }
      }
    }
    // Ascending gamePk, like the Rust adapter's BTreeMap, so the first failing game matches.
    return [...groups.keys()].sort((a, b) => a - b).flatMap((gamePk) => game(groups.get(gamePk)!, config) ?? []);
  },
  // Only final listings carry results, so a result counts at once.
  isResultEligible: () => true,
  // Official dates keep a doubleheader's games from informing each other's pregame model.
  pregameDay: (game) => game.date,
};
