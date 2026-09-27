import { z } from 'zod';
import { configSchema, gameFileSchema, gameSchema, seedSchema, validateGames } from './contracts.ts';
import type { Posterior } from './model.ts';
import type { PublicState } from './service.ts';
import type { Store } from './storage.ts';

export const snapshotKey = 'game-results-prediction:nfl:model-v1';
export type ModelSnapshot = { file: z.infer<typeof gameFileSchema>; model: Posterior; state: PublicState };

const finite = z.number().finite();
const probability = finite.min(0).max(1);
const prediction = z.object({
  home_win: probability,
  away_win: probability,
  tie: probability,
  home_probability_interval: z.tuple([probability, probability]),
});
const snapshotSchema = z.object({
  file: gameFileSchema,
  model: z.object({
    ids: z.array(z.string()).min(2),
    means: z.array(finite),
    covariance: z.array(z.array(finite)),
    seed: seedSchema,
    config: configSchema,
    games_used: z.number().int().nonnegative(),
    iterations: z.number().int().nonnegative(),
  }),
  state: z.object({
    status: z.literal('ready'),
    error: z.null(),
    warning: z.string().nullable(),
    league: z.string(),
    season: z.number().int(),
    refreshed_at: z.iso.datetime({ offset: true }),
    checked_at: z.iso.datetime({ offset: true }).nullable(),
    cached: z.boolean(),
    training_games: z.number().int().nonnegative(),
    historical_games: z.number().int().nonnegative(),
    held_results: z.number().int().nonnegative(),
    team_history: configSchema.shape.teams,
    source: z.string(),
    result_policy: z.string(),
    history_start: z.number().int(),
    teams: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        location: z.string(),
        abbreviation: z.string(),
        initial_elo: finite,
        rating: finite,
        sd: finite.nonnegative(),
      }),
    ),
    games: z.array(
      gameSchema.extend({ status: z.enum(['completed', 'scheduled', 'awaiting_result']), prediction: prediction.nullable() }),
    ),
  }),
});

export function readSnapshot(store: Store | null): ModelSnapshot | null {
  try {
    const raw = store?.getItem(snapshotKey);
    if (!raw) return null;
    const snapshot = snapshotSchema.parse(JSON.parse(raw));
    const { model, file, state } = snapshot;
    const size = model.ids.length;
    if (
      new Set(model.ids).size !== size ||
      model.means.length !== size ||
      model.covariance.length !== size ||
      model.covariance.some((row, i) => row.length !== size || row[i] < 0) ||
      model.ids.some((id) => !model.config.teams.some((t) => t.id === id)) ||
      state.teams.length !== size ||
      state.teams.some((t) => !model.ids.includes(t.id)) ||
      file.league !== model.config.id ||
      file.from_season !== state.season ||
      file.through_season !== state.season ||
      model.seed.target_season !== state.season ||
      file.source_url !== model.config.source.url ||
      state.games.length !== file.games.length
    )
      return null;
    file.games = validateGames(file.games, model.config);
    if (!file.games.length || file.games.some((g) => g.season !== state.season)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(store: Store | null, snapshot: ModelSnapshot): void {
  try {
    store?.setItem(snapshotKey, JSON.stringify(snapshot));
  } catch {
    // Storage failure must not discard a successfully fitted model.
  }
}
