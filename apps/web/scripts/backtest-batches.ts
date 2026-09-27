import type { Game } from '../src/contracts.ts';
import { startTimeUtc } from '../src/time.ts';

export function* utcDateBatches(games: Game[]): Generator<{ training: Game[]; testing: Game[] }> {
  const dated = games.map((game) => ({ game, date: (game.start_time_utc ?? startTimeUtc(game)).slice(0, 10) }));
  for (const date of [...new Set(dated.map((g) => g.date))].sort()) {
    yield {
      training: dated.filter((g) => g.date < date).map((g) => g.game),
      testing: dated.filter((g) => g.date === date).map((g) => g.game),
    };
  }
}
