# Add another league

The application has one shared logical game contract, implemented in Rust and validated at the TypeScript boundary. There is no NFL-specific team count, schedule length, or Elo formula in either model. The NFL CSV adapter and historical Super Bowl completeness check are provider-specific.

## Configuration

Copy `config/nfl.json` to a new file. Change its ID and name, complete team list, aliases, historical start, season rollover month, source, model settings, and tie rules. These are sport/league choices rather than values that can safely be inferred by a generic algorithm.

For the existing generic provider, use:

```json
{
  "kind": "canonical-json",
  "url": "https://your-provider.example/games.json"
}
```

Set `ties_allowed_in` to `[]` if no games may end in a tie, `["regular"]` if only regular-season games allow ties, or `["regular", "postseason"]` if both phases do. A normalized tie in a forbidden phase is rejected. Elo continues to support a 0.5 tie outcome where permitted.

Team IDs are stable franchise identities. Map renamed/relocated aliases to those identities, rather than creating a new team unless it is genuinely a new franchise. Each team has a current `name` and `location`, plus `eras` containing `from_season`, inclusive `through_season` (null for the open-ended current era), historical `name`, home-market `location`, and accepted `source_ids`. Eras must be contiguous and non-overlapping, cover the configured history start, and end in an open-ended era matching the current metadata. See `docs/team-history.md`. The first version assumes the configured roster is appropriate for the modeled historical period. Supporting league expansion *within* that period may need activation dates and a policy for new-team priors.

## Normalized provider response

The generic HTTPS endpoint returns all relevant historical seasons and the current season in this envelope. Additional envelope metadata is allowed. This example is illustrative, not actual game data:

```json
{
  "schema_version": 1,
  "league": "example",
  "games": [
    {
      "id": "2026-001",
      "league": "example",
      "season": 2026,
      "date": "2026-09-01",
      "time": "19:00",
      "timezone": "Europe/London",
      "phase": "regular",
      "round": "REG",
      "week": 1,
      "home_team": "TEAM_A",
      "away_team": "TEAM_B",
      "home_source_id": "TEAM_A",
      "away_source_id": "TEAM_B",
      "neutral": false,
      "result": "home_win"
    }
  ]
}
```

- `result`: `"home_win"`, `"away_win"`, `"tie"`, or `null` for a game without a confirmed final outcome. The provider is responsible for finality; provisional live outcomes must be null.
- `phase`: `"regular"` or `"postseason"`.
- `season`: a consistent integer season label, also for games played in the next calendar year.
- `date`, `time`, `timezone`: local calendar date, optional HH:mm kickoff, and IANA time zone. The date remains required when the time is null.
- `week`: positive integer round/week index; it is for display, not modeling.
- `round`: source-specific round label; it is metadata, not a rating input.
- `neutral`: true disables home advantage.
- `home_source_id`, `away_source_id`: original provider abbreviations/IDs. They must resolve to the matching stable franchise through configuration; use the stable IDs when your upstream uses them.
- `id`: unique game ID within the league, stable across updates and score corrections.

The importer accepts this exact envelope from HTTPS or through its `--input` file option. The TypeScript app independently downloads the provider and persists only the selected current season. The Elo program reads only historical JSON and does not depend on the provider implementation.

## Additional provider formats

To support an upstream API whose response differs from this contract, add an adapter in:

- `crates/rating-core/src/lib.rs`, for the historical importer.
- `apps/web/src/provider.ts`, for current-season refresh.

Update the source kind validation in both languages and add equivalent normalization fixtures. Keep source parsing separate from ratings. Never silently map unknown teams, turn missing results into ties, or reuse a previous season's priors when a new season begins.

Future multi-leg competitions, aggregate scores, or matches involving more than two teams require an expanded game and likelihood model; the supplied pairwise contract cannot represent them without a deliberate extension.
