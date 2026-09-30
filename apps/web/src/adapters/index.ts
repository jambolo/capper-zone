import type { LeagueConfig } from '../contracts.ts';
import { canonicalJson } from './canonical-json.ts';
import { mlbStatsApi } from './mlb-statsapi.ts';
import { nflverseCsv } from './nflverse-csv.ts';
import type { SourceAdapter } from './types.ts';

export type { SourceAdapter } from './types.ts';

/** Every source kind a league configuration may name. */
const adapters: readonly SourceAdapter[] = [nflverseCsv, canonicalJson, mlbStatsApi];

export function isSourceKind(kind: string): boolean {
  return adapters.some((adapter) => adapter.kind === kind);
}

export function adapterFor(config: Pick<LeagueConfig, 'source'>): SourceAdapter {
  const adapter = adapters.find((a) => a.kind === config.source.kind);
  if (!adapter) throw new Error('Unknown source adapter');
  return adapter;
}
