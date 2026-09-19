# Franchise identity and historical consistency

A franchise has one permanent `id`. Ratings and game counts are keyed by this ID. Its name, home market, and source abbreviation can change without starting a new rating history.

The initial permanent IDs resemble current abbreviations, but **must not be renamed when a franchise moves or changes its name**. For example, the ID `LV` represents the same Raiders franchise in both Oakland and Las Vegas. A future relocation adds an era and aliases while retaining `LV`.

## NFL identity changes within the imported period

| Permanent ID | Seasons | Historical name | Home market |
| --- | --- | --- | --- |
| `LV` | 2002–2019 | Oakland Raiders | Oakland |
| `LV` | 2020–present | Las Vegas Raiders | Las Vegas |
| `LAR` | 2002–2015 | St. Louis Rams | St. Louis |
| `LAR` | 2016–present | Los Angeles Rams | Los Angeles |
| `LAC` | 2002–2016 | San Diego Chargers | San Diego |
| `LAC` | 2017–present | Los Angeles Chargers | Los Angeles |
| `WAS` | 2002–2019 | Washington Redskins | Washington |
| `WAS` | 2020–2021 | Washington Football Team | Washington |
| `WAS` | 2022–present | Washington Commanders | Washington |

The ranges begin at the project's historical cutoff, not at franchise founding. All other configured teams have one open-ended identity era for this period.

Sources: [Raiders history](https://www.profootballhof.com/teams/las-vegas-raiders/team-history), [Rams history](https://www.profootballhof.com/teams/los-angeles-rams/team-history), [Chargers' first return season in Los Angeles](https://en.wikipedia.org/wiki/2017_Los_Angeles_Chargers_season), and [Washington history](https://www.profootballhof.com/teams/washington-commanders/team-history).

`location` means the franchise's home market or region. Stadium replacement, a stadium municipality changing within the same market, temporary home venues, and neutral-site games are separate venue concepts. They do not create new franchise identities. The normalized game's `neutral` flag determines whether the model applies home advantage.

## How it is stored

Each team in `config/nfl.json` has:

```json
{
  "id": "LV",
  "name": "Las Vegas Raiders",
  "location": "Las Vegas",
  "eras": [
    {
      "from_season": 2002,
      "through_season": 2019,
      "name": "Oakland Raiders",
      "location": "Oakland",
      "source_ids": ["OAK"]
    },
    {
      "from_season": 2020,
      "through_season": null,
      "name": "Las Vegas Raiders",
      "location": "Las Vegas",
      "source_ids": ["LV"]
    }
  ]
}
```

Both historical and current JSON files embed this identity registry under `teams`. Every game stores stable `home_team` / `away_team` values and the unmodified original `home_source_id` / `away_source_id` abbreviations. Thus an Oakland game stores `home_team: "LV"` and `home_source_id: "OAK"`; the game's season resolves its historical name and location from the embedded registry.

Season boundaries are inclusive. Postseason games played in January/February retain the season that started in the preceding calendar year, so the correct team identity carries through the entire season. Renames within a season would require extending the registry to effective dates; none of the included changes need that finer granularity.

## Validation and continuity

- A historical source abbreviation must resolve to exactly one stable franchise ID.
- Every game must have an identity era covering its season.
- Identity eras must not overlap or leave gaps; the final era is open-ended and matches the current team metadata.
- NFL source abbreviations must be valid in the game's era; an `LV` provider code in a 2019 NFL game is rejected instead of silently relabeling it.
- The Elo calculator refuses historical files whose embedded identity registry differs from the active configuration. After changing identity metadata, rerun the importer and then the Elo calculator.
- The React app uses the selected season's name and abbreviation, including when run for a historical backtest season, and exposes the change history in a table.
- Relocations and renames do **not** reset Elo or Bayesian strength, duplicate the franchise, or create an extra team. Only the ordinary configured offseason regression applies.

Tests check all included transition seasons, original-code preservation, invalid-era rejection, overlapping/gapped ranges, and a Raiders rating carried from a 2019 Oakland game into a 2020 Las Vegas game.
