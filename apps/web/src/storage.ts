import { configSchema, gameFileSchema, seedSchema, validateGames, type GameFile, type LeagueConfig } from './contracts.ts';

/** SHA-256 over the exact bytes served, so hashes match the ones the Rust programs wrote. */
export async function digest(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class NotFoundError extends Error {}

/** Published data files are static assets; a 404 means the generator has not run. */
async function fetchBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'no-store', ...(signal ? { signal } : {}) });
  if (response.status === 404) throw new NotFoundError(`Not published: ${url}`);
  if (!response.ok) throw new Error(`Could not read ${url}: HTTP ${response.status}`);
  return await response.arrayBuffer();
}
const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

export async function readConfig(url: string, signal?: AbortSignal) {
  const bytes = await fetchBytes(url, signal);
  return { config: configSchema.parse(JSON.parse(decode(bytes))), hash: await digest(bytes) };
}

export async function readSeed(
  url: string,
  historyUrl: string,
  config: LeagueConfig,
  configHash: string,
  season: number,
  signal?: AbortSignal,
) {
  const seed = seedSchema.parse(JSON.parse(decode(await fetchBytes(url, signal))));
  if (seed.league !== config.id || seed.target_season !== season || seed.through_season !== season - 1)
    throw new Error('Elo seed is for the wrong league or season; run the two Rust programs');
  if (seed.config_sha256 !== configHash) throw new Error('Configuration changed since Elo was calculated; rerun elo-ratings');
  if ((await digest(await fetchBytes(historyUrl, signal))) !== seed.history_sha256)
    throw new Error('History changed since Elo was calculated; rerun elo-ratings');
  return seed;
}

/** The browser cache replaces the Node build's on-disk snapshot. It keeps the visible
 * cached-data fallback working when the provider cannot be reached, and it is per-browser:
 * it never substitutes for the published history and Elo files.
 */
export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export const browserStore = (): Store | null => {
  try {
    const probe = '__probe__';
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null; // Private mode or blocked storage: run without a fallback cache.
  }
};
export const memoryStore = (): Store => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};

export function readCache(store: Store | null, key: string, config: LeagueConfig, season: number): GameFile | null {
  const raw = store?.getItem(key);
  if (raw == null) return null;
  const file = gameFileSchema.parse(JSON.parse(raw));
  if (
    file.league !== config.id ||
    file.from_season !== season ||
    file.through_season !== season ||
    file.source_url !== config.source.url
  )
    throw new Error('Cache belongs to another source or season');
  if (JSON.stringify(file.teams) !== JSON.stringify(config.teams))
    throw new Error('Cache team identity history does not match the configuration');
  file.games = validateGames(file.games, config);
  if (!file.games.length || file.games.some((g) => g.season !== season)) throw new Error('Invalid current-season cache');
  return file;
}

export function writeCache(store: Store | null, key: string, value: GameFile): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A full or unavailable quota only costs the offline fallback, never the prediction.
  }
}
