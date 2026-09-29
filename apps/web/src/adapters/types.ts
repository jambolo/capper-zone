import type { Game, LeagueConfig } from '../contracts.ts';

export interface SourceAdapter {
  /** Registry key; equals config.source.kind. */
  readonly kind: string;
  /** Whether validateGames requires each source id to be listed in its franchise era for that season. */
  readonly strictSourceIds: boolean;
  /** Whether parse() supplies each game's start_time_utc from the provider; validateGames then keeps it. */
  readonly sourceStartTimes?: boolean;
  /** `summary`: one-line status-card copy. `detail`: PublicState.result_policy. */
  readonly resultPolicy: { readonly summary: string; readonly detail: string };
  /** Adapter-specific configuration problem, or null when the configuration suits this adapter. */
  validateConfig?(config: LeagueConfig): string | null;
  /** URLs to download, in order, for one season's games. */
  seasonUrls(config: LeagueConfig, season: number): string[];
  /** Normalize downloaded documents (same order as seasonUrls) into unvalidated game records. */
  parse(documents: readonly string[], config: LeagueConfig): unknown[];
  /** Called only for games with a non-null result: may the result train the model at `now`? */
  isResultEligible(game: Game, now: Date): boolean;
  /** YYYY-MM-DD day key; a completed game's pregame model uses only results with a strictly earlier key. */
  pregameDay(game: Game): string;
}
