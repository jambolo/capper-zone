import { z } from 'zod';
import { startTimeUtc } from '../time.ts';
import type { SourceAdapter } from './types.ts';

/** Canonical JSON envelope for any league; the provider returns only final results. */
export const canonicalJson: SourceAdapter = {
  kind: 'canonical-json',
  strictSourceIds: false,
  resultPolicy: {
    summary: 'Results enter the picture as soon as the provider reports them.',
    detail: 'The provider supplies completed game outcomes.',
  },
  seasonUrls: (config) => [config.source.url],
  parse(documents, config) {
    if (documents.length !== 1) throw new Error(`The canonical-json adapter expects exactly one document, got ${documents.length}`);
    const canonical = (id: string) => config.aliases[id] ?? id;
    const data = z
      .object({
        schema_version: z.literal(2),
        league: z.literal(config.id),
        games: z.array(z.unknown()),
      })
      .parse(JSON.parse(documents[0]));
    return data.games.map((g) => {
      const row = z.object({ home_team: z.string(), away_team: z.string() }).passthrough().parse(g);
      return {
        ...row,
        home_team: canonical(row.home_team),
        away_team: canonical(row.away_team),
      };
    });
  },
  isResultEligible: () => true,
  pregameDay: (game) => (game.start_time_utc ?? startTimeUtc(game)).slice(0, 10),
};
