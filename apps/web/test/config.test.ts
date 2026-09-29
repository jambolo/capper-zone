import { expect, it } from 'vitest';
import { configSchema, monthDayOrdinal, windowsSchema } from '../src/contracts.ts';
import { configBytes } from './helpers.ts';

const rawConfig = () => JSON.parse(configBytes.toString()) as Record<string, unknown>;

const windows = (season: [string, string], postseason: [string, string]) => ({
  season: { start: season[0], end: season[1] },
  postseason: { start: postseason[0], end: postseason[1] },
});

const messages = (value: unknown) => windowsSchema.safeParse(value).error?.issues.map((i) => i.message);

it('accepts the NFL config with year-wrapping windows', () => {
  expect(configSchema.safeParse(rawConfig()).success).toBe(true);
});

it('accepts non-wrapping windows', () => {
  expect(messages(windows(['03-20', '11-05'], ['09-30', '11-05']))).toBeUndefined();
});

it('computes non-leap day-of-year ordinals', () => {
  expect(['01-01', '02-15', '02-28', '09-01', '12-31', '02-29'].map(monthDayOrdinal)).toEqual([1, 46, 59, 244, 365, null]);
});

it.each(['02-29', '13-01', '04-31', '00-10', '01-00', '9-01', '09-1'])('rejects invalid month-day %s', (v) => {
  expect(messages(windows([v, '02-15'], ['01-08', '02-15']))).toEqual(['Invalid month-day']);
});

it('rejects a postseason window outside the season window', () => {
  for (const post of [
    ['01-08', '02-20'],
    ['08-15', '02-15'],
    ['02-15', '01-08'],
  ] as [string, string][]) {
    expect(messages(windows(['09-01', '02-15'], post))).toEqual(['Postseason window must lie within the season window']);
  }
});

it('rejects equal season start and end', () => {
  expect(messages(windows(['09-01', '09-01'], ['09-01', '09-01']))).toEqual(['Season window start and end must be different']);
});

it('rejects schema_version 1', () => {
  expect(configSchema.safeParse({ ...rawConfig(), schema_version: 1 }).success).toBe(false);
});

it('rejects an unknown schedule_filter unit', () => {
  const raw = rawConfig() as { display: { schedule_filter: { unit: string } } };
  raw.display.schedule_filter.unit = 'week';
  expect(configSchema.safeParse(raw).success).toBe(false);
});

it('rejects an unknown source kind', () => {
  const raw = { ...rawConfig(), source: { kind: 'bogus', url: 'https://example.com/games.json' } };
  expect(configSchema.safeParse(raw).success).toBe(false);
});

it('accepts a null round_name', () => {
  const raw = rawConfig() as { display: { round_name: string | null } };
  raw.display.round_name = null;
  expect(configSchema.safeParse(raw).success).toBe(true);
});
