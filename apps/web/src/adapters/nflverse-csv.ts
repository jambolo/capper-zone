import { parse } from 'csv-parse/browser/esm/sync';
import { DateTime } from 'luxon';
import type { Game } from '../contracts.ts';
import { startTimeUtc } from '../time.ts';
import type { SourceAdapter } from './types.ts';

/** nflverse `games.csv`: one whole-history file with Eastern local dates and no live/final flag. */
export const nflverseCsv: SourceAdapter = {
  kind: 'nflverse-csv',
  strictSourceIds: true,
  resultPolicy: {
    summary: "Today's results enter the picture the next day, Eastern Time.",
    detail: 'Results from today are held until the next calendar day in Eastern Time because the source has no live/final flag.',
  },
  seasonUrls: (config) => [config.source.url],
  parse(documents, config) {
    if (documents.length !== 1) throw new Error(`The nflverse-csv adapter expects exactly one document, got ${documents.length}`);
    const canonical = (id: string) => config.aliases[id] ?? id;
    const rows = parse(documents[0], {
      columns: true,
      skip_empty_lines: true,
      bom: true,
    }) as Record<string, string>[];
    const required = [
      'game_id',
      'season',
      'game_type',
      'week',
      'gameday',
      'gametime',
      'away_team',
      'away_score',
      'home_team',
      'home_score',
      'location',
    ];
    if (!rows.length || required.some((k) => !(k in rows[0]))) throw new Error('Unexpected nflverse CSV header or empty response');
    const score = (s: string) => {
      if (s === '') return null;
      if (!/^\d+$/.test(s)) throw new Error(`Invalid source score: ${s}`);
      return Number(s);
    };
    const games: Game[] = [];
    for (const r of rows) {
      if (Number(r.season) < config.history_start || ['PRE', 'PRO', 'PB'].includes(r.game_type)) continue;
      if (!['REG', 'WC', 'DIV', 'CON', 'SB'].includes(r.game_type)) throw new Error(`Unknown game type: ${r.game_type}`);
      if (!['Home', 'Neutral'].includes(r.location)) throw new Error(`Unknown game location: ${r.game_id}`);
      const home = score(r.home_score),
        away = score(r.away_score);
      if ((home === null) !== (away === null)) throw new Error(`Only one score for ${r.game_id}`);
      games.push({
        id: r.game_id,
        league: config.id,
        season: Number(r.season),
        date: r.gameday,
        time: r.gametime || null,
        timezone: 'America/New_York',
        phase: r.game_type === 'REG' ? 'regular' : 'postseason',
        round_label: r.game_type,
        round: Number(r.week),
        home_team: canonical(r.home_team),
        away_team: canonical(r.away_team),
        neutral: r.location === 'Neutral',
        home_source_id: r.home_team,
        away_source_id: r.away_team,
        result: home === null || away === null ? null : home > away ? 'home_win' : home < away ? 'away_win' : 'tie',
      });
    }
    return games;
  },
  // No live/final flag: a score counts only once its Eastern local date has passed.
  isResultEligible: (game, now) => game.date < DateTime.fromJSDate(now).setZone(game.timezone).toISODate()!,
  pregameDay: (game) =>
    DateTime.fromISO(game.start_time_utc ?? startTimeUtc(game), { zone: 'utc' })
      .setZone('America/New_York')
      .toISODate()!,
};
