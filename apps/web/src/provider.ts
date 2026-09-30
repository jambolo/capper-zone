import { adapterFor } from './adapters/index.ts';
import { validateGames, type Game, type LeagueConfig } from './contracts.ts';

/** Every source adapter returns the same normalized, result-only contract. */
export function parseSource(documents: string | readonly string[], config: LeagueConfig): Game[] {
  const docs = typeof documents === 'string' ? [documents] : documents;
  return validateGames(adapterFor(config).parse(docs, config), config);
}

/** Results the model may train on at `now`; each source adapter decides when a reported result is final.
 * Cached games keep every provider result; only eligible ones are consumed.
 */
export function usableResults(games: Game[], config: LeagueConfig, now = new Date()): Game[] {
  const adapter = adapterFor(config);
  return games.filter((g) => g.result !== null && adapter.isResultEligible(g, now));
}

export async function download(url: string): Promise<string> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // No custom User-Agent: browsers forbid setting it, and it would force a CORS preflight.
      const response = await fetch(url, {
        signal: AbortSignal.timeout(25_000),
        cache: 'no-cache',
      });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      return await response.text();
    } catch (e) {
      last = e;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Could not refresh the source: ${last instanceof Error ? last.message : String(last)}`);
}
