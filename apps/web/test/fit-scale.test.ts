import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Game, LeagueConfig } from '../src/contracts.ts';
import { fitPosterior } from '../src/model.ts';
import { game, seed } from './helpers.ts';

// Mirrors crates/rating-core/tests/fit_scale.rs: same generator, seed value, and fixed model settings, so both
// languages fit the identical 2,430-game season. With plain objective summation this fit does not converge.
const mlb = JSON.parse(readFileSync(new URL('../../../config/mlb.json', import.meta.url), 'utf8')) as LeagueConfig;
const config: LeagueConfig = {
  ...mlb,
  elo: { ...mlb.elo, initial: 1500, scale: 400, home_advantage: 24 },
  bayesian: { ...mlb.bayesian, prior_sd_elo: 75 },
};

function syntheticSeason(value: number) {
  let state = value >>> 0;
  const draw = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 16;
  };
  const teams = config.teams.map((t) => t.id);
  const elo = teams.map(() => 1400 + (draw() % 201));
  const games: Game[] = [];
  for (let i = 0; i < 2430; i++) {
    const h = draw() % teams.length;
    let a = draw() % (teams.length - 1);
    if (a >= h) a += 1;
    const result = draw() % 1000 < 535 + elo[h] - elo[a] ? 'home_win' : 'away_win';
    games.push(game({ id: `g${i}`, league: config.id, home_team: teams[h], away_team: teams[a], neutral: false, result }));
  }
  const ratings = teams.map((team, i) => ({ team, elo: elo[i], games: 162 }));
  return { seed: { ...seed(), league: config.id, tie_weight: 0.0003, ratings }, games };
}

it('converges on an MLB-scale synthetic season', () => {
  expect(config.teams).toHaveLength(30);
  const { seed: prior, games } = syntheticSeason(4558);
  const model = fitPosterior(prior, games, config);
  expect(model.games_used).toBe(2430);
  expect(model.means.every(Number.isFinite)).toBe(true);
  expect(model.covariance.flat().every(Number.isFinite)).toBe(true);
  model.covariance.forEach((row, i) => expect(row[i]).toBeGreaterThan(0));
});
