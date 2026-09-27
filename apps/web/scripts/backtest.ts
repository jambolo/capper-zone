import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configSchema, currentSeason, seedSchema, type LeagueConfig } from '../src/contracts.ts';
import { fitPosterior, predict } from '../src/model.ts';
import { download, parseSource, usableResults } from '../src/provider.ts';
import { digest } from '../src/storage.ts';
import { utcDateBatches } from './backtest-batches.ts';

const root = resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'data-dir': { type: 'string' },
    season: { type: 'string' },
  },
});

// The browser app reads these files over HTTP; the backtest reads the same files from disk.
const configBytes = await readFile(resolve(root, values.config ?? 'config/nfl.json'));
const config: LeagueConfig = configSchema.parse(JSON.parse(configBytes.toString('utf8')));
const season = Number(values.season ?? currentSeason(config));
const dir = resolve(root, values['data-dir'] ?? 'data', config.id);

const seed = seedSchema.parse(JSON.parse(await readFile(resolve(dir, `elo-${season}.json`), 'utf8')));
if (seed.league !== config.id || seed.target_season !== season || seed.through_season !== season - 1)
  throw new Error('Elo seed is for the wrong league or season; run the two Rust programs');
if (seed.config_sha256 !== (await digest(configBytes)))
  throw new Error('Configuration changed since Elo was calculated; rerun elo-ratings');
if ((await digest(await readFile(resolve(dir, 'history.json')))) !== seed.history_sha256)
  throw new Error('History changed since Elo was calculated; rerun elo-ratings');

const downloaded = parseSource(await download(config.source.url), config).filter((g) => g.season === season);
const games = usableResults(downloaded, config);
if (!games.length) throw new Error('No completed games to evaluate');
let logLoss = 0,
  brier = 0,
  baselineLogLoss = 0,
  baselineBrier = 0;
// Batch by UTC date: no same-UTC-day or later outcome can leak into a prediction.
for (const { training, testing } of utcDateBatches(games)) {
  const model = fitPosterior(seed, training, config);
  for (const g of testing) {
    const p = predict(model, g.home_team, g.away_team, g.neutral, g.phase);
    const classes = ['home_win', 'away_win', 'tie'] as const;
    const q = config.ties_allowed_in.includes(g.phase) ? seed.tie_weight / (2 + seed.tie_weight) : 0;
    const base = { home_win: (1 - q) / 2, away_win: (1 - q) / 2, tie: q };
    logLoss -= Math.log(Math.max(p[g.result!], 1e-15));
    baselineLogLoss -= Math.log(Math.max(base[g.result!], 1e-15));
    for (const outcome of classes) {
      brier += (p[outcome] - Number(g.result === outcome)) ** 2;
      baselineBrier += (base[outcome] - Number(g.result === outcome)) ** 2;
    }
  }
}
console.log(
  JSON.stringify(
    {
      season,
      games: games.length,
      method: 'Predict using only results from earlier UTC dates; multiclass Brier score, natural-log loss',
      bayesian: { log_loss: logLoss / games.length, brier: brier / games.length },
      equal_strength_baseline: {
        log_loss: baselineLogLoss / games.length,
        brier: baselineBrier / games.length,
      },
      note: 'These are diagnostics, not proof of calibration or superiority. Hyperparameters must be chosen on separate earlier seasons.',
    },
    null,
    2,
  ),
);
