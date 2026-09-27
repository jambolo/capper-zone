import { DateTime } from 'luxon';

/** Match the historical import policy, including deterministic DST overlap resolution. */
export function startTimeUtc(game: { id: string; date: string; time: string | null; timezone: string }): string {
  const time = game.time?.trim() || '00:00';
  let local = DateTime.fromISO(`${game.date}T${time}`, { zone: game.timezone });
  if (!local.isValid) throw new Error(`Invalid source date, time, or timezone for game ${game.id}`);
  // Luxon shifts times in DST gaps forward; use local midnight instead.
  if (local.toISODate() !== game.date || local.toFormat('HH:mm') !== time) {
    local = DateTime.fromISO(`${game.date}T00:00`, { zone: game.timezone });
    if (!local.isValid || local.toISODate() !== game.date || local.toFormat('HH:mm') !== '00:00')
      throw new Error(`Game ${game.id}: local midnight on ${game.date} does not exist in ${game.timezone}`);
  }
  const earliest = Math.min(...local.getPossibleOffsets().map((t) => t.toMillis()));
  return DateTime.fromMillis(earliest, { zone: 'utc' }).toISO({ suppressMilliseconds: true })!;
}
