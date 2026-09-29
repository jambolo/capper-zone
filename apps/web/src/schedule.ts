import type { Game, LeagueConfig } from './contracts.ts';

type Display = LeagueConfig['display'];
export type ScheduleUnit = Display['schedule_filter']['unit'];

/** Schedule filter value of a game: its round number or its source-local date. */
export function scheduleKey(game: Pick<Game, 'round' | 'date'>, unit: ScheduleUnit): string {
  return unit === 'round' ? String(game.round) : game.date;
}

/** Distinct schedule filter values: rounds in ascending numeric order, dates in ascending order. */
export function scheduleOptions(games: readonly Pick<Game, 'round' | 'date'>[], unit: ScheduleUnit): string[] {
  const keys = [...new Set(games.map((game) => scheduleKey(game, unit)))];
  return unit === 'round' ? keys.sort((a, b) => Number(a) - Number(b)) : keys.sort();
}

/** Postseason tag of a game row: the label configured for its round code, else the league default. */
export function postseasonLabel(game: Pick<Game, 'round_label'>, display: Display): string {
  const labels = display.postseason_round_labels;
  // Own keys only, so a round code such as "constructor" cannot resolve to an Object.prototype member.
  return Object.hasOwn(labels, game.round_label) ? labels[game.round_label] : display.postseason_label;
}
