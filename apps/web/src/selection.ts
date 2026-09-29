import { monthDayOrdinal, type LeagueConfig } from './contracts.ts';
import { rememberedLeagueKey } from './small-store.ts';
import { readConfig, type Store } from './storage.ts';

/** A registry league's id with its configured season and postseason windows. */
export type LeagueWindows = { id: string; windows: LeagueConfig['windows'] };

/** Browser-local calendar date as MM-DD; February 29 counts as February 28. */
export function localMonthDay(now: Date = new Date()): string {
  const month = now.getMonth() + 1;
  const day = month === 2 && now.getDate() === 29 ? 28 : now.getDate();
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Non-leap day of year of an MM-DD; February 29 counts as February 28. */
function ordinal(monthDay: string): number {
  const value = monthDayOrdinal(monthDay === '02-29' ? '02-28' : monthDay);
  if (value === null) throw new Error(`Invalid month-day: ${monthDay}`);
  return value;
}
/** Whether day of year `t` lies in the window, both ends included, wrapping at the year boundary. */
const within = (window: { start: string; end: string }, t: number) =>
  (t - ordinal(window.start) + 365) % 365 <= (ordinal(window.end) - ordinal(window.start) + 365) % 365;
/** Days from day of year `t` forward to `monthDay`. */
const daysUntil = (monthDay: string, t: number) => (ordinal(monthDay) - t + 365) % 365;
/** The league with the fewest days; strict comparison keeps registry order on ties. */
const soonest = (leagues: readonly LeagueWindows[], days: (league: LeagueWindows) => number) =>
  leagues.reduce((best, league) => (days(league) < days(best) ? league : best));

/** In-season default for `today` (MM-DD) over `leagues` in registry order; null when `leagues` is empty.
 * One league in season wins. Several in season: the first in its postseason window, else the fewest days until
 * a postseason start. None in season: the fewest days until a season start. Ties go to registry order.
 */
export function defaultLeagueId(leagues: readonly LeagueWindows[], today: string): string | null {
  if (!leagues.length) return null;
  const t = ordinal(today);
  const inSeason = leagues.filter((league) => within(league.windows.season, t));
  if (inSeason.length === 1) return inSeason[0].id;
  if (inSeason.length > 1) {
    const inPostseason = inSeason.filter((league) => within(league.windows.postseason, t));
    if (inPostseason.length) return inPostseason[0].id;
    return soonest(inSeason, (league) => daysUntil(league.windows.postseason.start, t)).id;
  }
  return soonest(leagues, (league) => daysUntil(league.windows.season.start, t)).id;
}

/** The registry id a `#<id>` location hash names exactly (case-sensitive), else null. */
export function leagueFromHash(hash: string, ids: readonly string[]): string | null {
  if (!hash.startsWith('#')) return null;
  const id = hash.slice(1);
  return ids.includes(id) ? id : null;
}

/** The remembered league when it is a registry id; unreadable storage remembers nothing. */
export function rememberedLeague(store: Store | null, ids: readonly string[]): string | null {
  try {
    const id = store?.getItem(rememberedLeagueKey) ?? null;
    return id !== null && ids.includes(id) ? id : null;
  } catch {
    return null;
  }
}

/** The league a valid hash or remembered choice decides at startup, else null (the default rule decides). */
export function explicitLeague(ids: readonly string[], hash: string, store: Store | null): string | null {
  return leagueFromHash(hash, ids) ?? rememberedLeague(store, ids);
}

/** Startup league: a valid hash, else the remembered league, else the in-season default. `loadWindows` is called
 * only when the default rule decides; when it yields no registry league, the first registry id wins.
 */
export async function startupLeague(options: {
  ids: readonly string[];
  hash: string;
  store: Store | null;
  today: string;
  loadWindows: () => Promise<readonly LeagueWindows[]>;
}): Promise<string> {
  const { ids } = options;
  const explicit = explicitLeague(ids, options.hash, options.store);
  if (explicit !== null) return explicit;
  let loaded: readonly LeagueWindows[] = [];
  try {
    loaded = await options.loadWindows();
  } catch {
    /* No windows: fall back to registry order. */
  }
  const inRegistryOrder = ids.flatMap((id) => loaded.filter((league) => league.id === id).slice(0, 1));
  return defaultLeagueId(inRegistryOrder, options.today) ?? ids[0];
}

/** Each registry league's name and windows from `<configBase>/<id>.json`, fetched in parallel, in registry order.
 * Leagues whose configuration fails to load, or names another id, are left out.
 */
export async function loadLeagueConfigs(
  ids: readonly string[],
  configBase: string,
  read: (url: string) => Promise<{ config: LeagueConfig }> = readConfig,
): Promise<{ id: string; name: string; windows: LeagueConfig['windows'] }[]> {
  const base = configBase.replace(/\/$/, '');
  const results = await Promise.allSettled(ids.map((id) => read(`${base}/${id}.json`)));
  return results.flatMap((result, i) =>
    result.status === 'fulfilled' && result.value.config.id === ids[i]
      ? [{ id: ids[i], name: result.value.config.name, windows: result.value.config.windows }]
      : [],
  );
}

/** League to switch to after a `hashchange`: a registry id other than `current`, else null. */
export function hashChangeTarget(hash: string, current: string, ids: readonly string[]): string | null {
  const id = leagueFromHash(hash, ids);
  return id !== null && id !== current ? id : null;
}

/** Records a switch to `id`: sets the location hash to `#<id>` (a history entry; skipped when already equal) and
 * remembers the league (storage errors ignored).
 */
export function recordSwitch(id: string, target: { location: { hash: string }; store: Store | null }): void {
  if (target.location.hash !== `#${id}`) target.location.hash = `#${id}`;
  try {
    target.store?.setItem(rememberedLeagueKey, id);
  } catch {
    /* The switch still applies to this page. */
  }
}
