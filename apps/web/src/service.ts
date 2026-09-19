import { DateTime } from 'luxon';
import type { EloSeed, Game, GameFile, LeagueConfig } from './contracts.ts';
import { fitPosterior, predict, teamEstimates, type Posterior, type Prediction } from './model.ts';
import { download, parseSource, usableResults } from './provider.ts';
import { browserStore, readCache, readSeed, writeCache, type Store } from './storage.ts';

export type GameView = Game & {
  status: 'completed' | 'scheduled' | 'awaiting_result';
  prediction: Prediction | null;
};
export type PublicState = {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  warning: string | null;
  league: string;
  season: number;
  refreshed_at: string | null;
  cached: boolean;
  training_games: number;
  historical_games: number;
  held_results: number;
  team_history: LeagueConfig['teams'];
  source: string;
  result_policy: string;
  history_start: number;
  teams: ReturnType<typeof teamEstimates>;
  games: GameView[];
};

export class PredictionService {
  readonly config: LeagueConfig;
  readonly season: number;
  private model: Posterior | null = null;
  private seed: EloSeed | null = null;
  private state: PublicState;
  constructor(
    private options: {
      config: LeagueConfig;
      configHash: string;
      /** Base URL the published `data/<league>/` files are served from. */
      dataBase: string;
      season: number;
      store?: Store | null;
      fetchSource?: typeof download;
      now?: () => Date;
    },
  ) {
    this.config = options.config;
    this.season = options.season;
    this.state = {
      team_history: this.config.teams,
      status: 'loading',
      error: null,
      warning: null,
      league: this.config.name,
      season: this.season,
      refreshed_at: null,
      cached: false,
      training_games: 0,
      historical_games: 0,
      held_results: 0,
      source: this.config.source.url,
      history_start: this.config.history_start,
      teams: [],
      games: [],
      result_policy:
        this.config.source.kind === 'nflverse-csv'
          ? 'Results from today are held until the next calendar day in Eastern Time because the source has no live/final flag.'
          : 'The provider supplies completed game outcomes.',
    };
  }
  getState(): PublicState {
    return this.state;
  }
  predict(home: string, away: string, neutral: boolean, phase: Game['phase']) {
    if (!this.model) throw new Error('Predictions are not ready');
    return predict(this.model, home, away, neutral, phase);
  }
  async initialize(): Promise<void> {
    const dir = `${this.options.dataBase.replace(/\/$/, '')}/${this.config.id}`;
    const store = this.options.store === undefined ? browserStore() : this.options.store;
    const cacheKey = `game-results-prediction:${this.config.id}:current-${this.season}`;
    const now = (this.options.now ?? (() => new Date()))();
    try {
      // A startup always attempts the current-season refresh, even if the seed needs rebuilding.
      let cache: GameFile | null = null,
        cacheProblem = '';
      try {
        cache = readCache(store, cacheKey, this.config, this.season);
      } catch (e) {
        cacheProblem = `Existing cache could not be read: ${message(e)}. `;
      }
      let file: GameFile;
      try {
        const text = await (this.options.fetchSource ?? download)(this.config.source.url);
        const games = parseSource(text, this.config).filter((g) => g.season === this.season);
        if (!games.length) throw new Error(`The source has no games for season ${this.season} yet`);
        if (cache) {
          const incoming = new Map(games.map((g) => [g.id, g]));
          for (const old of usableResults(cache.games, this.config, now)) {
            if (!incoming.get(old.id)?.result)
              throw new Error(`Refresh lost a previously completed game (${old.id}); cached data retained`);
          }
        }
        file = {
          schema_version: 1,
          league: this.config.id,
          fetched_at: now.toISOString(),
          source_url: this.config.source.url,
          from_season: this.season,
          through_season: this.season,
          teams: this.config.teams,
          games,
        };
        writeCache(store, cacheKey, file);
        if (cacheProblem) this.state.warning = `${cacheProblem}Replaced it with a valid download.`;
      } catch (e) {
        if (!cache) throw new Error(`${cacheProblem}${message(e)}. No valid current-season cache is available.`, { cause: e });
        file = cache;
        this.state.cached = true;
        this.state.warning = `Refresh failed. Using cached data from ${cache.fetched_at}. ${message(e)}`;
      }
      this.state.refreshed_at = file.fetched_at;
      try {
        this.seed = await readSeed(
          `${dir}/elo-${this.season}.json`,
          `${dir}/history.json`,
          this.config,
          this.options.configHash,
          this.season,
        );
      } catch (e) {
        throw new Error(
          `Current-season data is available, but the published initial ratings could not be loaded. ${message(e)}. Run history-importer followed by elo-ratings, then rebuild the site.`,
          { cause: e },
        );
      }
      const results = usableResults(file.games, this.config, now),
        completed = new Set(results.map((g) => g.id));
      this.model = fitPosterior(this.seed, results, this.config);
      this.state.teams = teamEstimates(this.model);
      this.state.training_games = results.length;
      this.state.historical_games = this.seed.completed_games;
      this.state.held_results = file.games.filter((g) => g.result !== null && !completed.has(g.id)).length;
      this.state.games = file.games.map((g) => {
        const kickoff = DateTime.fromISO(`${g.date}T${g.time ?? '00:00'}`, {
          zone: g.timezone,
        });
        const status = completed.has(g.id) ? 'completed' : kickoff.toMillis() <= now.getTime() ? 'awaiting_result' : 'scheduled';
        return {
          ...g,
          result: completed.has(g.id) ? g.result : null,
          status,
          prediction: status === 'scheduled' ? predict(this.model!, g.home_team, g.away_team, g.neutral, g.phase) : null,
        };
      });
      this.state.status = 'ready';
    } catch (e) {
      this.state.status = 'error';
      this.state.error = message(e);
    }
  }
}
export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
