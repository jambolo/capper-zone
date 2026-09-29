import { expect, it } from 'vitest';
import { postseasonLabel, scheduleKey, scheduleOptions } from '../src/schedule.ts';
import { config, game } from './helpers.ts';

const games = [
  game({ id: 'a', round: 10, date: '2026-11-15' }),
  game({ id: 'b', round: 2, date: '2026-09-14' }),
  game({ id: 'c', round: 1, date: '2026-09-07' }),
  game({ id: 'd', round: 2, date: '2026-09-14' }),
  game({ id: 'e', round: 1, date: '2026-09-08' }),
];

it('keys games by round number or by date', () => {
  expect(scheduleKey(game({ round: 3, date: '2026-09-21' }), 'round')).toBe('3');
  expect(scheduleKey(game({ round: 3, date: '2026-09-21' }), 'date')).toBe('2026-09-21');
});

it('lists distinct rounds in ascending numeric order', () => {
  expect(scheduleOptions(games, 'round')).toEqual(['1', '2', '10']);
});

it('lists distinct dates in ascending order', () => {
  expect(scheduleOptions(games, 'date')).toEqual(['2026-09-07', '2026-09-08', '2026-09-14', '2026-11-15']);
});

it('returns no options for no games', () => {
  expect(scheduleOptions([], 'round')).toEqual([]);
  expect(scheduleOptions([], 'date')).toEqual([]);
});

it('falls back to the league postseason label', () => {
  expect(postseasonLabel(game({ round_label: 'SB' }), config.display)).toBe('Playoffs');
  expect(postseasonLabel(game({ round_label: 'constructor' }), config.display)).toBe('Playoffs');
});

it('uses a configured round label when one exists', () => {
  const display = { ...config.display, postseason_label: 'Postseason', postseason_round_labels: { WS: 'World Series' } };
  expect(postseasonLabel(game({ round_label: 'WS' }), display)).toBe('World Series');
  expect(postseasonLabel(game({ round_label: 'DS' }), display)).toBe('Postseason');
});
