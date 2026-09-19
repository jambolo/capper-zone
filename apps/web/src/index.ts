/** Public surface of the browser prediction app: the league contracts, the provider
 * adapters, the Bayesian model, and the service that assembles them.
 */
export {
  configSchema,
  gameSchema,
  gameFileSchema,
  seedSchema,
  teamSchema,
  validateGames,
  currentSeason,
  teamIdentity,
  type EloSeed,
  type Game,
  type GameFile,
  type LeagueConfig,
} from './contracts.ts';
export {
  fitPosterior,
  outcomeProbabilities,
  predict,
  teamEstimates,
  type Posterior,
  type Prediction,
  type Probabilities,
} from './model.ts';
export { download, parseSource, usableResults } from './provider.ts';
export { PredictionService, message, type GameView, type PublicState } from './service.ts';
export {
  browserStore,
  digest,
  memoryStore,
  readCache,
  readConfig,
  readSeed,
  writeCache,
  NotFoundError,
  type Store,
} from './storage.ts';
