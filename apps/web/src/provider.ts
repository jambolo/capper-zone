import { parse } from 'csv-parse/browser/esm/sync';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { validateGames, type Game, type LeagueConfig } from './contracts.ts';

/** Both providers return the same normalized, result-only contract. */
export function parseSource(text: string, config: LeagueConfig): Game[] {
  const canonical = (id: string) => config.aliases[id] ?? id;
  if (config.source.kind === 'canonical-json') {
    const data = z
      .object({
        schema_version: z.literal(2),
        league: z.literal(config.id),
        games: z.array(z.unknown()),
      })
      .parse(JSON.parse(text));
    const games = data.games.map((g) => {
      const row = z.object({ home_team: z.string(), away_team: z.string() }).passthrough().parse(g);
      return {
        ...row,
        home_team: canonical(row.home_team),
        away_team: canonical(row.away_team),
      };
    });
    return validateGames(games, config);
  }
  const rows = parse(text, {
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
  return validateGames(games, config);
}

/** The CSV has no live/final flag. Avoid interpreting in-progress scores as finals.
 * Keep provider results in the cache; only consume results from earlier local dates.
 * A canonical-json provider is responsible for returning only final results.
 */
export function usableResults(games: Game[], config: LeagueConfig, now = new Date()): Game[] {
  return games.filter(
    (g) =>
      g.result !== null &&
      (config.source.kind !== 'nflverse-csv' || g.date < DateTime.fromJSDate(now).setZone(g.timezone).toISODate()!),
  );
}

export async function download(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // No custom User-Agent: browsers forbid setting it, and it would force a CORS preflight.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(25_000),
        cache: 'no-cache',
      });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      return await response.text();
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Could not refresh the source: ${last instanceof Error ? last.message : String(last)}`);
}
