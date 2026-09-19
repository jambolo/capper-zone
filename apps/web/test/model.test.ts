import { describe, it, expect } from 'vitest';
import { fitPosterior, outcomeProbabilities, predict, teamEstimates } from '../src/model.ts';
import { config, seed, game } from './helpers.ts';

describe('Bayesian model', () => {
  it('uses the Elo seed as the prior and preserves uncertainty without results', () => {
    const s = seed();
    s.ratings.find((t) => t.team === 'SEA')!.elo = 1700;
    const model = fitPosterior(s, [], config),
      row = teamEstimates(model).find((t) => t.id === 'SEA')!;
    expect(row.rating).toBeCloseTo(1700, 10);
    expect(row.sd).toBeCloseTo(150, 10);
    const p = predict(model, 'SEA', 'SF', true, 'regular');
    expect(p.home_win).toBeGreaterThan(p.away_win);
    expect(p.home_win + p.away_win + p.tie).toBeCloseTo(1, 12);
    expect(p.home_probability_interval[0]).toBeLessThan(p.home_win);
    expect(p.home_probability_interval[1]).toBeGreaterThan(p.home_win);
  });
  it('updates both teams for a win and retains posterior correlation', () => {
    const model = fitPosterior(seed(), [game()], config),
      h = model.ids.indexOf('SEA'),
      a = model.ids.indexOf('SF');
    expect(model.means[h]).toBeGreaterThan(0);
    expect(model.means[a]).toBeLessThan(0);
    expect(model.covariance[h][a]).toBeGreaterThan(0);
    expect(teamEstimates(model).find((t) => t.id === 'SEA')!.sd).toBeLessThan(config.bayesian.prior_sd_elo);
  });
  it('treats ties as a proper third outcome and moves an overmatched favorite down', () => {
    const s = seed();
    s.ratings.find((t) => t.team === 'SEA')!.elo = 1700;
    const model = fitPosterior(s, [game({ result: 'tie' })], config);
    expect(teamEstimates(model).find((t) => t.id === 'SEA')!.rating).toBeLessThan(1700);
    expect(predict(model, 'SEA', 'SF', true, 'regular').tie).toBeGreaterThan(0);
    expect(predict(model, 'SEA', 'SF', true, 'postseason').tie).toBe(0);
    expect(() => fitPosterior(s, [game({ result: 'tie', phase: 'postseason' })], config)).toThrow(/Tie/);
  });
  it('matches the analytic two-team Hessian for an equal-strength tie', () => {
    const model = fitPosterior(seed(), [game({ result: 'tie' })], config);
    const v = ((150 * Math.LN10) / 400) ** 2,
      p = 1 / v,
      h = 1 / (2 * (2 + 0.02));
    const determinant = p * p + 2 * p * h;
    const i = model.ids.indexOf('SEA'),
      j = model.ids.indexOf('SF');
    expect(model.means[i]).toBeCloseTo(0, 12);
    expect(model.covariance[i][i]).toBeCloseTo((p + h) / determinant, 12);
    expect(model.covariance[i][j]).toBeCloseTo(h / determinant, 12);
  });
  it('is symmetric under team reversal at neutral venues and handles home advantage', () => {
    const m = fitPosterior(seed(), [game()], config);
    const a = predict(m, 'SEA', 'SF', true, 'regular'),
      b = predict(m, 'SF', 'SEA', true, 'regular');
    expect(a.home_win).toBeCloseTo(b.away_win, 12);
    expect(a.tie).toBeCloseTo(b.tie, 12);
    expect(predict(m, 'SEA', 'SF', false, 'regular').home_win).toBeGreaterThan(a.home_win);
    expect(() => predict(m, 'SEA', 'SEA', true, 'regular')).toThrow();
  });
  it('is invariant to observation order and does not compound results on refits', () => {
    const games = [game(), game({ id: 'g2', result: 'away_win' }), game({ id: 'g3', away_team: 'KC', result: 'tie' })];
    const a = fitPosterior(seed(), games, config),
      b = fitPosterior(seed(), [...games].reverse(), config),
      c = fitPosterior(seed(), games, config);
    a.means.forEach((x, i) => {
      expect(x).toBeCloseTo(b.means[i], 10);
      expect(x).toBeCloseTo(c.means[i], 12);
    });
    expect(() => fitPosterior(seed(), [game(), game()], config)).toThrow(/duplicated/);
    expect(() => fitPosterior(seed(), [game({ season: 2025 })], config)).toThrow();
  });
  it('keeps extreme outcome probabilities finite and normalized', () => {
    for (const d of [-10000, -100, 0, 100, 10000]) {
      const p = outcomeProbabilities(d, 0.02);
      expect(p.home_win + p.away_win + p.tie).toBeCloseTo(1, 12);
      expect(Object.values(p).every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
    }
  });
});
