# Add another league

Rust and TypeScript provider adapters share the same team and outcome metadata. Historical storage uses an authoritative UTC start time; the current-season browser also keeps source-local timing fields. There is no NFL-specific team count, schedule length, or Elo formula in either model. The NFL CSV adapter and historical Super Bowl completeness check are provider-specific.

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

Team IDs are stable franchise identities. Map renamed/relocated aliases to those identities, rather than creating a new team unless it is genuinely a new franchise. Each team has a current `name` and `location`, plus `eras` containing `from_season`, inclusive `through_season` (null for the open-ended current era), historical `name`, home-market `location`, and accepted `source_ids`. Eras must be contiguous and non-overlapping, cover the configured history start, and end in an open-ended era matching the current metadata. See [franchise identity rules](team-history.md). The model assumes the configured team list is appropriate for the entire modeled historical period. Supporting league expansion *within* that period may need activation dates and a policy for new-team priors.

## Wire the browser

The algorithms and provider contracts support other leagues, but the shipped browser interface is wired
to the NFL. Creating another configuration file alone does not add a league selector.

1. Generate history and the target-season Elo seed using that configuration and the Rust commands in
   [DEVELOPMENT.md](../DEVELOPMENT.md#generating-data-and-configuring-seasons).
2. Change `configUrl` in `apps/web/src/App.tsx` from `config/nfl.json` to the configuration to publish.
   The Vite build includes JSON files from the repository's `config/` and `data/` directories. If a CLI
   uses another data directory, update the Vite data mount or copy its outputs into `data/<league>/`.
3. Replace the NFL-specific model snapshot, refresh-lock, and cooldown keys in `apps/web/src/snapshot.ts`
   and `apps/web/src/session.ts`. Namespace them by league if supporting multiple leagues in one browser.
4. Adapt interface defaults and labels such as **NFL**, **Week**, **Kickoff**, and **Playoffs** in
   `apps/web/src/App.tsx`, then rebuild and deploy the app with its matching data.

The provider endpoint must permit browser requests through CORS. An authoritative final-status policy
belongs in the provider: the canonical adapter trusts every non-null outcome as final.

## Provider response

The generic HTTPS endpoint returns all relevant historical seasons and the current season in this envelope. Additional envelope metadata is allowed. This example is illustrative, not actual game data:

```json
{
  "schema_version": 2,
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
      "round_label": "REG",
      "round": 1,
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
- `date`, `time`, `timezone`: local calendar date, optional HH:mm game start time, and IANA time zone. The date remains required when the time is null.
- `start_time_utc`: omit this field in provider responses. Both adapters derive it from the required local date, optional time, and timezone. The Rust importer ignores a supplied value; the browser validates any supplied value's format before replacing it with the derived timestamp.
- `round`: positive integer round index; it is for display, not modeling.
- `round_label`: source-specific round label; it is metadata, not a rating input.
- `neutral`: true disables home advantage.
- `home_source_id`, `away_source_id`: original provider abbreviations/IDs. They must resolve to the matching stable franchise through configuration; use the stable IDs when your upstream uses them.
- `id`: unique game ID within the league, stable across updates and score corrections.

Normalization sorts by `(season, start_time_utc, id)`, using IANA timezone rules for historical daylight saving offsets. A missing date is a source error and aborts the import without replacing the saved history. A missing time (omitted, null, or empty) or a time in a daylight saving gap uses local midnight. A repeated time during a daylight saving overlap uses the earlier UTC occurrence. The importer prints warnings to stderr identifying each affected game and the fallback or selected occurrence. If local midnight itself does not exist, import fails. Historical output discards the original local fields. The current-season browser retains them for display and provider-specific result eligibility.

The importer accepts this exact envelope from HTTPS or through its `--input` file option. The TypeScript app independently downloads the provider and persists only the selected current season. The Elo program reads only historical JSON and does not depend on the provider implementation.

## Historical output

The importer writes `data/<league>/history.json` with these fields:

| Field | Contents |
| --- | --- |
| `schema_version` | `3` |
| `league` | League ID matching the configuration |
| `fetched_at` | RFC 3339 timestamp of the import |
| `source_url` | Configured provider URL |
| `from_season` | First included season |
| `through_season` | Last included season, inclusive |
| `teams` | Franchise identity registry described in [Configuration](#configuration) |
| `games` | Array of normalized historical game records |

Each game has the following structure. This example is illustrative, not actual game data:

```json
{
  "id": "2026-001",
  "league": "example",
  "season": 2026,
  "start_time_utc": "2026-09-01T18:00:00Z",
  "phase": "regular",
  "round_label": "REG",
  "round": 1,
  "home_team": "TEAM_A",
  "away_team": "TEAM_B",
  "home_source_id": "TEAM_A",
  "away_source_id": "TEAM_B",
  "neutral": false,
  "result": "home_win"
}
```

The identity, season, phase, venue, and result fields follow the [provider contract](#provider-response).
Historical records store `start_time_utc` instead of the provider's `date`, `time`, and `timezone` fields.
The importer serializes this required timestamp as RFC 3339 UTC with `Z`. Readers treat it as the
authoritative start instant, require an explicit offset, and sort games by `(season, start_time_utc, id)`.
Missing, null, or malformed timestamps are errors.

The browser and Node backtest verify the history file's hash; they obtain game records from the provider
and do not deserialize the historical game records.

Generate the Elo seed from the published history and configuration so its SHA-256 hashes match those files.

## Additional provider formats

To support an upstream API whose response differs from this contract, add an adapter in:

- `crates/rating-core/src/lib.rs`, for the historical importer.
- `apps/web/src/provider.ts`, for current-season refresh.

Update the source kind validation in both languages and add equivalent normalization fixtures. Keep source parsing separate from ratings. Never silently map unknown teams, turn missing results into ties, or reuse a previous season's priors when a new season begins.

Future multi-leg competitions, aggregate scores, or matches involving more than two teams require an expanded game and likelihood model; the supplied pairwise contract cannot represent them without a deliberate extension.
