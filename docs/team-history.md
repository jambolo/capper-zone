# Franchise identity and historical consistency

See [franchise continuity](model.md#franchise-continuity) for rating behavior,
[configuration](extending.md#configuration) for era fields and structural validation, and
[`config/nfl.json`](../config/nfl.json) for the NFL identity ranges and aliases.

## Identity details

- Permanent IDs initially resemble current abbreviations. A future Raiders relocation would still use
  `LV`, even if the provider adopts a new abbreviation.
- Identity ranges begin at the project's historical cutoff, not at franchise founding.
- Renames within a season would require extending the registry to effective dates.
- NFL source abbreviations must be valid in the game's era. An `LV` provider code in a 2019 game is
  rejected even though `LV` is the permanent franchise ID.
- Team estimates resolve names and abbreviations from the model's target season.

## Registry consistency

The browser's current-season cache embeds the `teams` registry described in the
[historical output format](extending.md#historical-output). The Elo seed contains ratings and
configuration/history hashes, not a copy of the registry.

The Elo calculator refuses historical files whose embedded identity registry differs from the active
configuration. Regeneration commands are in [Development](../DEVELOPMENT.md#data-and-configuration).

## Historical sources

Sources for the configured NFL identity transitions:

- [Raiders history](https://www.profootballhof.com/teams/las-vegas-raiders/team-history)
- [Rams history](https://www.profootballhof.com/teams/los-angeles-rams/team-history)
- [Chargers' first return season in Los Angeles](https://en.wikipedia.org/wiki/2017_Los_Angeles_Chargers_season)
- [Washington history](https://www.profootballhof.com/teams/washington-commanders/team-history)
