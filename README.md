# Capper Zone

Game results prediction: two Rust command-line programs build historical ratings, two evaluate Elo and
Bayesian parameter choices, and a TypeScript browser app turns ratings into matchup probabilities. The browser app
is a static site — there is no database server, API key, subscription, or backend to configure.

| App | Path | Kind | Run |
| --- | --- | --- | --- |
| history-importer | `apps/history-importer` | Rust CLI | `cargo run --release -p history-importer` |
| elo-ratings | `apps/elo-ratings` | Rust CLI | `cargo run --release -p elo-ratings` |
| elo-tune | `apps/elo-tune` | Rust CLI | `cargo run --release -p elo-tune` |
| bayes-tune | `apps/bayes-tune` | Rust CLI | `cargo run --release -p bayes-tune` |
| web | `apps/web` | TypeScript browser app (Vite + React) | `pnpm -C apps/web dev` |

`crates/rating-core` holds the shared Rust data contracts, adapters, file IO, Elo replay, and Bayesian model. It is a library.

## What each program does

1. **`history-importer` — Rust:** downloads historical game outcomes into JSON text files.
2. **`elo-ratings` — Rust:** reads those files, replays games chronologically, and writes preseason Elo ratings and a per-game audit trail.
3. **`elo-tune` — Rust:** searches Elo parameters against saved historical games and reports tuning and held-out evaluation; it never changes configuration or data files.
4. **`bayes-tune` — Rust:** searches Bayesian prior uncertainty and tie smoothing against saved history with Elo settings fixed; reports tuning and held-out evaluation without changing inputs.
5. **`web` — TypeScript:** a static React app. It immediately restores cached predictions, checks the current season in the background on page load, and rebuilds the Bayesian model when normalized game data changes. Downloads and fitting run in a Web Worker.

## Quick start

Install the current **Node LTS**, **pnpm 12.4.2** (`pnpm self-update 12`), and **stable Rust 1.85 or later** with Cargo — the
crates use edition 2024. On Ubuntu, compiling Rust dependencies also needs `build-essential`, `pkg-config`,
and `ca-certificates`. Add the `rustfmt` and `clippy` components (`rustup component add rustfmt clippy`) to
run the format and lint checks locally.

```bash
pnpm -C apps/web install --frozen-lockfile
cargo run --release -p history-importer
cargo run --release -p elo-ratings
pnpm -C apps/web dev
```

Open the URL Vite prints. On subsequent runs, just run `pnpm -C apps/web dev`; the Rust programs do not need
to run each time.

For a production build:

```bash
pnpm -C apps/web build      # writes apps/web/dist
pnpm -C apps/web preview
```

## Publishing

`.github/workflows/pages.yml` builds the site for GitHub Pages: it runs both Rust programs, then builds
`apps/web`, then deploys `apps/web/dist`. The generated `data/` and the league `config/` are published as
static assets next to the bundle, so the browser reads exactly the files the Rust programs wrote.

The published site is served from a repository subpath, so the build sets Vite's `base`. Override it with
`VITE_BASE` when publishing elsewhere.

## Historical scope and data source

The NFL configuration starts in **2002**, the first season of the Houston Texans, the league's most recent
expansion team. It includes **regular-season and postseason games, including the Super Bowl**. Preseason and
exhibition games are excluded.

The source is the maintained [nflverse/nfldata games dataset](https://github.com/nflverse/nfldata), exposed
as a downloadable CSV. [nflreadr documents this source](https://nflreadr.nflverse.com/reference/load_schedules.html).
The [Pro Football Hall of Fame's Texans history](https://www.profootballhof.com/teams/houston-texans/team-history)
documents their 2002 debut.

The adapter reads scores only to determine **win, loss, or tie**. Scores, margin of victory, rosters,
injuries, play-by-play, and betting markets are neither stored in normalized game files nor used by either
rating model. A missing pair of scores is an unplayed/unreported outcome, never a tie. The importer verifies
that every requested historical NFL season has a completed Super Bowl before replacing the history file.

Imported games are ordered chronologically using UTC start times. The importer reports missing-time and
daylight saving adjustments on stderr and rejects games whose dates cannot be resolved. See
[docs/extending.md](docs/extending.md) for timestamp rules and data formats.

**Current results have a deliberate delay:** nflverse's CSV has no explicit live/final status. The app
checks the entire current-season snapshot on load (subject to a one-minute cooldown), but only results from *earlier calendar dates in
Eastern Time* enter the model. Today's results become eligible on the following day. This prevents
provisional live scores from being treated as final results. The provider itself can have additional
publication delays. A future adapter with an authoritative final-status flag can remove this restriction.

## Text files and ownership

All persisted data is readable, formatted JSON under `data/<league>/`:

| File | Written by | Contents |
| --- | --- | --- |
| `history.json` | Rust importer | Completed games through the season before the target season, plus the effective-season franchise identity registry |
| `elo-<target-season>.json` | Rust Elo calculator | Preseason ratings for the target season, model settings, source/configuration hashes, tie parameter, per-game Elo audit |

By default, the year is selected from the current UTC date using the configured rollover month. Explicit `--season` / `--target-season` /
`--through-season` arguments override the selection.

Rust writes use a temporary file in the same directory, flush it, and atomically rename it, under an
OS-released file lock. Data files are ignored by Git and regenerated by the Pages workflow.

The browser stores current-season games, the fitted model, and displayed predictions in `localStorage`.
Returning visits show the saved results before any network request. A Web Worker checks for updates and
rebuilds only when normalized current-season game data differs; changes to CSV formatting, row order,
or scores that do not change the outcome do not trigger a rebuild. A notification remains visible during
rebuilding, and the old results remain usable until the complete replacement is ready. Failed updates
retain the previous snapshot with a warning. The page shows when its displayed data was retrieved and
when it was last successfully checked; these are browser timestamps, not the provider's publication time.

A refresh-attempt timestamp is saved before work starts. Rapid reloads wait until 60 seconds after that
attempt before checking again, including after an interrupted attempt. Web Locks coordinate tabs where
supported; the cache and cooldown are rechecked after acquiring the lock. Without Web Locks, the cooldown
still limits sequential reloads, but simultaneous tabs can race. HTTP revalidation avoids downloading an
unchanged CSV body when the browser has a cached response. Unloading terminates the worker; unfinished
work may need to restart after the cooldown. After the load's check completes, there is no periodic polling.
Unavailable or full browser storage prevents persistence across reloads; the app still runs without it.

Automatic invalidation for midnight result eligibility, season rollover, configuration changes, updated
Elo seeds, and model-code changes is deferred. An unchanged game snapshot can therefore retain predictions
from before those changes. Clear the site's saved data to force an initial build with the current inputs.
Initial builds validate the published history and Elo files; a cached model can display without fetching them.

The app never modifies historical data or Elo files. Rebuilds use the original priors and the current set
of results, so reloads do not double-count games. Corrected outcomes take effect on the next successful
update. A source response that drops an already completed game is rejected, preserving the previous
snapshot. Editing model configuration or replacing history requires
rerunning `elo-ratings`, because the files are linked by SHA-256 hashes. After editing franchise identities
or aliases, rerun the importer first, then Elo, so every saved file contains the same identity registry.

## Model choices

Model settings are configurable in [config/nfl.json](config/nfl.json). The current NFL settings are:

| Parameter | Configured value |
| --- | --- |
| Initial Elo | 1500 |
| Elo scale | 400 |
| Elo update factor K | 40 |
| Home advantage | 45 Elo points; zero at neutral venues |
| Offseason regression | 38.3333% of the distance toward 1500 each season |
| Bayesian prior standard deviation | 100 Elo points per team |
| Tie smoothing | Approximately 212.132 pseudo-games with a 0.707107% tie rate |

Elo uses results of 1, 0, or 0.5 for wins, losses, or ties. All included games have the same K; a playoff win
has the same update rule as a regular-season win. Historical ratings carry between years with offseason
regression. The output priors apply the final offseason regression exactly once.

The prediction model is **Bayesian Bradley–Terry with Davidson's tie extension**. Normal priors are centered
on preseason Elo. All eligible current-season results jointly update team strengths. A multivariate Laplace
approximation provides the posterior and retains correlations between teams. Predictions integrate over the
uncertain strength difference; ties have their own outcome probability. NFL playoff predictions give ties
probability zero. See [docs/model.md](docs/model.md) for formulas and limitations.

The app includes any-two-team matchup selection, neutral-site and game-phase options, win/tie/loss
probabilities, a probability credible interval, the current schedule/results, and a table of preseason and
current team-strength estimates.

Completed games show the actual result alongside the expected winner and win probability reconstructed
from the preseason seed and results before the game's start date. The cutoff is midnight Eastern Time for NFL
data and midnight UTC for canonical providers. Same-day and later outcomes are excluded because the data
does not record game-end timestamps.

## Commands and configuration

Run these from the repository root.

```bash
# Explicit historical training period and target season
cargo run --release -p history-importer -- --through-season 2025
cargo run --release -p elo-ratings -- --target-season 2026

# Alternate league configuration and output folder
cargo run --release -p history-importer -- --config config/example.json --data-dir data-example
cargo run --release -p elo-ratings -- --config config/example.json --data-dir data-example

# Import a previously downloaded provider file
cargo run --release -p history-importer -- --input /absolute/path/to/games.csv

# Everything CI enforces
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm -C apps/web lint
pnpm -C apps/web format:check
pnpm -C apps/web test
pnpm -C apps/web build
```

The `example.json` filename above illustrates how to supply your own configuration; no fictional league is
configured by default. `config/nfl.json` is the included production configuration, published to the site and
read by the browser at `config/nfl.json`.

For each new NFL season, run the importer and Elo calculator again and rebuild the site. The importer is
intentionally restricted to historical seasons. A new season's current data belongs only to the browser app.

## Elo-only tuning

`elo-tune` reads the existing `data/nfl/history.json` once and runs entirely offline. It searches
`elo.k`, `elo.home_advantage`, and `elo.offseason_regression`, using the same chronological Elo replay as
`elo-ratings`. It prints a JSON report to stdout and progress to stderr. It does not use published Elo seeds,
fit a Bayesian model, estimate tie probabilities, or modify any input files.

```bash
cargo run --release -p elo-tune

# Also save a report named with the league and UTC run date
cargo run --release -p elo-tune -- --report-dir target

# Explicit paths and chronological split (these are the defaults)
cargo run --release -p elo-tune -- --config config/nfl.json --data-dir data \
  --tune-start 2010 --tune-end 2022 --test-end 2025
```

`--report-dir` creates the directory if needed and saves `elo-tuning-report-<league>-<YYYY-MM-DD>.json`,
for example `target/elo-tuning-report-nfl-2026-09-26.json`. The date comes from the report's UTC `run_at`
timestamp. Another run for the same league and date replaces that report. JSON is still printed to stdout.

Defaults use 2002–2009 for warm-up, 2010–2022 for selection, and 2023–2025 for held-out evaluation.
The league config's `elo_tune` section supplies `tune_start`, `tune_end`, and `test_end`; the corresponding
CLI options override them individually. Without `elo_tune`, all three CLI options are required.
History must contain completed games for every season, including a completed Super Bowl for each NFL season.
The initial rating and Elo scale stay fixed at their configured values. The objective is equally weighted
**season mean squared error** between each pre-game expected score and its outcome (win = 1, tie = 0.5,
loss = 0). This evaluates Elo's fractional expected score, not three separate outcome probabilities.

The search starts with 125 combinations: K = `{10, 15, 20, 30, 40}`, home advantage = `{0, 25, 40, 55, 70}`,
and regression = `{0, 0.15, 1/3, 0.5, 0.75}`. Current settings are also included. When the minimum lies at an
expandable boundary, the grid expands up to four times: halve/double the lower/upper K boundary, add 25 to
the upper home advantage, or extend regression to 1. Home advantage stays nonnegative and regression stays
within `[0, 1]`. The three best grid points are refined with offsets `{-2, -1, 0, 1, 2}` times steps of 2.5 K,
5 home Elo, and 0.05 regression, discarding invalid values.

To avoid choosing an isolated minimum, selection prefers the candidate closest to current settings among
those within one paired-season standard error of the minimum MSE. Distance is the sum of squared parameter
differences divided by current K, 25 home Elo, and 0.25 regression respectively, before squaring. Lower MSE
breaks distance ties. The report includes both this conservative selection and the absolute minimum.
This is a stability heuristic, not a statistical significance test.

Only after selection is frozen are the chosen and current settings evaluated on the held-out seasons.
Earlier held-out outcomes update ratings for later games, but never change the selected parameters.
The report includes per-season and pooled MSE, first/second halves of each season by game count, expected-score
calibration bins, paired differences and descriptive standard errors, the ten lowest-MSE candidates,
input SHA-256 hashes, and an RFC 3339 UTC run-start timestamp (`run_at`). Positive MSE improvement means the
selected settings performed better. The report does not claim an improvement is established when it is small
or inconsistent; limited held-out seasons constrain
inference. Repeatedly changing the search after reading holdout scores would invalidate that evaluation.

## Bayesian parameter tuning

`bayes-tune` reads `data/nfl/history.json` and searches `bayesian.prior_sd_elo`,
`bayesian.tie_prior_games`, and `bayesian.tie_prior_rate`. All Elo settings remain fixed. It runs entirely
offline, does not read published Elo seeds, and never modifies configuration or historical data.

```powershell
cargo run --release -p bayes-tune
cargo run --release -p bayes-tune -- --report-dir target
cargo run --release -p bayes-tune -- --config config/nfl.json --data-dir data --tune-start 2010 --tune-end 2022 --test-end 2025
```

The optional `bayes_tune` configuration section takes `tune_start`, `tune_end`, and `test_end`, just like
`elo_tune`. When absent, `elo_tune` supplies the defaults; CLI options override individual boundaries.
Without either section, all three CLI boundaries are required. The included configuration therefore uses
2002–2009 for warm-up, 2010–2022 for selection, and 2023–2025 for held-out evaluation. At least one warm-up
season, two tuning seasons, and one later completed held-out season are required. History validation is
shared with `elo-tune`, including the completed Super Bowl check for NFL source data.

For each evaluated season, preseason Elo and the tie estimate use only earlier seasons. Elo replay and
historical matchup differences are cached across candidates; tie weights are cached by smoothing pair.
Each UTC date is predicted from a fresh fit using only earlier dates in that season. Same-day outcomes
cannot influence one another. The Rust model matches the browser's Davidson likelihood, Laplace covariance,
and Simpson integration, with a shared numerical fixture tested in both languages. Team strength resets to
the newly generated preseason prior at each season boundary; Bayesian posteriors do not carry across seasons.

The initial grid has 120 combinations:

| Parameter | Search values |
| --- | --- |
| `prior_sd_elo` | 50, 75, 100, 150, 200, 300 |
| `tie_prior_games` | 10, 30, 100, 300, 1000 |
| `tie_prior_rate` | 0.001, 0.0025, 0.005, 0.01 |

Current settings are also included. The three best initial candidates receive one local refinement using
each parameter multiplied by `1/sqrt(2)`, `1`, or `sqrt(2)`; rates must stay below 1. Duplicate candidates
are skipped. This is a bounded search, not a guarantee of a global optimum.

Selection minimizes equally weighted **season mean log loss**, using natural logs and all three outcomes.
Among candidates within one paired-season standard error of the minimum, it prefers the smallest sum of
squared log parameter ratios relative to current settings, breaking ties by log loss. The report identifies
both this conservative selection and the absolute minimum. Rare ties may leave smoothing parameters weakly
identified; this preference is a stability heuristic, not a significance test.

Only after selection is frozen are current and selected settings evaluated on the held-out seasons.
Earlier held-out outcomes can inform later predictions but never change selected parameters. Holdout validity
also requires that these seasons did not influence Elo settings or earlier search choices.

JSON goes to stdout; progress goes to stderr. `--report-dir` also writes
`bayes-tuning-report-<league>-<UTC run date>.json`, replacing a same-day report for that league. Reports include
input hashes, fixed Elo settings, the search grid and refinement, top candidates, per-season and pooled log
loss/Brier scores, first/second season halves, per-outcome calibration, expected versus observed ties, and
paired season differences. Brier score sums squared errors across all three outcomes. Positive log-loss
improvement means the selected parameters performed better. Configuration changes remain a separate action;
after changing parameters, regenerate Elo seeds because configuration hashes and tie weights must agree.

## Bayesian backtesting

The included backtest predicts each game using only results from earlier **UTC dates**. Outcomes on the same
UTC date cannot leak into predictions, even when the source uses mixed timezones. It reports multiclass Brier score and natural-log loss against an equal-strength baseline.
It runs in Node, reading the same files from disk that the browser reads over HTTP.

```bash
# Example: evaluate 2025 with priors trained through 2024, in an isolated folder
cargo run --release -p history-importer -- --through-season 2024 --data-dir data-backtest
cargo run --release -p elo-ratings -- --target-season 2025 --data-dir data-backtest
pnpm -C apps/web backtest -- --season 2025 --data-dir data-backtest
```

Tune parameters only on earlier seasons, then evaluate on a held-out season. No backtest automatically
changes your settings.

## Extending to another league

The Elo and Bayesian algorithms are league-independent. Team IDs, aliases, historical start, season rollover,
tie rules, and model parameters live in configuration.

Both Rust and TypeScript also implement a **`canonical-json` adapter**. A different league can use an HTTPS
endpoint that returns the documented common game format, without changing either model. The endpoint must
send permissive CORS headers, because the browser fetches it directly. See
[docs/extending.md](docs/extending.md) for a complete example.

Mappings preserve franchise continuity: `OAK → LV`, `SD → LAC`, and `STL/LA → LAR`; historical Washington and
Jacksonville aliases also normalize. Each game also preserves the original provider abbreviations. Names and
home markets are resolved from **season-based identity eras**, so old games retain the correct historical
identity. The UI displays a franchise-history table. Changes in rosters, coaches, or team ownership do not
create new team identities. See [docs/team-history.md](docs/team-history.md) for the exact ranges and
validation rules.

## Project layout

| Directory | Purpose |
| --- | --- |
| `apps/history-importer/` | Rust historical-download executable |
| `apps/elo-ratings/` | Rust Elo executable |
| `apps/elo-tune/` | Offline Elo parameter search and held-out evaluation |
| `apps/bayes-tune/` | Offline Bayesian parameter search with fixed Elo and held-out evaluation |
| `apps/web/src/` | Browser app: contracts, provider adapters, Bayesian model, service, React interface |
| `apps/web/test/` | Prediction, provider, startup/cache, and identity tests |
| `apps/web/scripts/` | Node backtest |
| `crates/rating-core/` | Shared Rust data contracts, adapters, file IO, Elo replay, Bayesian model, and tuning validation |
| `config/` | League and model settings |
| `docs/` | Statistical model, extension guide, franchise history, verification record |

Dependency versions are recorded in `apps/web/pnpm-lock.yaml` and `Cargo.lock`. `apps/web/pnpm-workspace.yaml`
holds the pnpm settings; esbuild is the only dependency allowed to run an install script. pnpm 12 verifies the
lockfile against a supply-chain cooldown, so a lockfile regenerated within 24 hours of a dependency's release
will be rejected until that release ages out.

`pnpm run docs` needs the explicit `run`: pnpm 12 has its own `docs` subcommand that shadows the script.

HTTPS verification uses the operating system's trusted certificates in Rust (rustls with
`rustls-native-certs`) and the browser's trust store in the web app.

Implementation checks and their scope are recorded in [docs/verification.md](docs/verification.md).
