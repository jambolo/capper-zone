# Development

This guide covers local setup, project structure, data generation, tuning commands, and changes to Rally Row.
For browser usage, see [README.md](README.md). For statistical methodology, see [docs/model.md](docs/model.md).

## Local setup

Use **Node LTS** and **current stable Rust with Cargo**, matching CI. Use the pnpm version pinned in
[`apps/web/package.json`](apps/web/package.json), currently **12.4.2**. The Rust crates use edition 2024;
the workspace does not declare or test a minimum supported Rust version for the full dependency graph.
On Ubuntu, compiling Rust dependencies also needs `build-essential`, `pkg-config`, and `ca-certificates`.
Add the `rustfmt` and `clippy` components (`rustup component add rustfmt clippy`) for local checks.

Run commands from the repository root unless otherwise noted:

```powershell
pnpm -C apps/web install --frozen-lockfile
cargo run --release -p history-importer
cargo run --release -p elo-ratings
pnpm -C apps/web dev
```

Open the URL Vite prints. On subsequent runs, just run `pnpm -C apps/web dev`; the Rust programs do not need
to run each time. The browser app is a static site with no database server, API key, or backend to configure.

## Project structure

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

Dependency versions are recorded in `apps/web/pnpm-lock.yaml` and `Cargo.lock`.
[`apps/web/pnpm-workspace.yaml`](apps/web/pnpm-workspace.yaml) holds the pnpm settings; esbuild is the only
dependency allowed to run an install script. Release-age checks have version-specific exceptions for
`@types/node@26.6.2` and `eslint@10.11.0`. Consult that file when updating dependencies rather than assuming
every package follows the same release-age policy.

HTTPS verification uses the operating system's trusted certificates in Rust (rustls with
`rustls-native-certs`) and the browser's trust store in the web app.

Implementation checks and their scope are recorded in [docs/verification.md](docs/verification.md).

### Programs

1. **`history-importer` — Rust:** downloads historical game outcomes into JSON text files.
2. **`elo-ratings` — Rust:** reads those files, replays games chronologically, and writes preseason Elo ratings and a per-game audit trail.
3. **`elo-tune` — Rust:** searches Elo parameters against saved historical games and reports tuning and held-out evaluation; it never changes configuration or data files.
4. **`bayes-tune` — Rust:** searches Bayesian prior uncertainty and tie smoothing against saved history with Elo settings fixed; reports tuning and held-out evaluation without changing inputs.
5. **`web` — TypeScript:** a static React app. It immediately restores cached predictions, checks the current season in the background on page load, and rebuilds the Bayesian model when normalized game data, result eligibility, configuration, or published preseason ratings and history change. Downloads and fitting run in a Web Worker.

## Building and publishing

For a production build:

```powershell
pnpm -C apps/web build      # writes apps/web/dist
pnpm -C apps/web preview
```

`.github/workflows/pages.yml` builds the site for GitHub Pages: it runs `history-importer` and `elo-ratings`,
then builds `apps/web` and deploys `apps/web/dist`. The generated `data/` and the league `config/` are published as
static assets next to the bundle, so the browser reads exactly the files the Rust programs wrote.

The Pages workflow sets `VITE_BASE` from the repository name, publishing this repository at `/rally-row/`.
The local default in `apps/web/vite.config.ts` is still `/capper-zone/`; use the URL Vite prints or set
`VITE_BASE` explicitly. For a build hosted at a domain root:

```powershell
$env:VITE_BASE = '/'
pnpm -C apps/web build
```

### CI, releases, and coverage

- `ci-rust.yml` and `ci-web.yml` run on pushes to `master`, `develop`, and `release/**`, and on pull requests.
  Builds and tests run on Ubuntu and Windows; lint and formatting jobs run on pull requests.
- Both CI workflows upload coverage to Codecov on `develop`, with separate `rust` and `web` flags.
- `cd.yml` runs when `Cargo.toml` or `apps/web/package.json` changes on `master`. After builds and tests,
  it creates missing `v<project-version>` and `web-v<app-version>` tags and merges `master` into `develop`
  if it created a tag. It does not create GitHub releases or publish the website.
- `pages.yml` deploys the website from `master` on pushes and manual dispatch. Its weekly Tuesday
  schedule dispatches a build on `master` only on the first Tuesday of each month at 09:17 UTC.

The README's CI and coverage badges track `develop`; its CD and Pages badges track `master`.

### Versioning strategy

Maintain two version numbers. Tags and GitHub releases derive their versions from these manifests:

| Scope | Source of truth | Git tag | GitHub release title |
| --- | --- | --- | --- |
| Entire project | `Cargo.toml`: `[workspace.package].version` | `vX.Y.Z` | `Rally Row X.Y.Z` |
| Web app | `apps/web/package.json`: `version` | `web-vA.B.C` | `Rally Row Web A.B.C` |

The project version covers the entire repository: Rust components, web app, configuration, documentation,
and GitHub workflows. Every project release increments it. All Rust crates inherit this version, including
when a release changes only the web app or workflows.

Increment the app version when releasing changes to the browser app's code or behavior. Every app release
belongs to a project release, so it also requires a project version bump. A project release can retain the
previous app version. The two version numbers do not need to match.

The app version is also the model-cache compatibility version. `apps/web/src/version.ts` reads it from
`apps/web/package.json`; the page and worker bundle that same value, and the footer displays it.
Bump the app version before deploying changes to prediction behavior or serialized snapshot structure,
including dependency changes that affect either. Snapshots require an exact version match, so every app
version change, including a UI-only release or a downgrade, forces a rebuild. Bumping only the project
version does not invalidate browser models. Pages does not enforce this rule; deployments that reuse an
app version cannot detect code changes through version checking.

Use [Semantic Versioning](https://semver.org/), choosing each version's increment for its own scope:

- **Major:** incompatible changes to supported interfaces or behavior, such as CLI or data contracts.
- **Minor:** backward-compatible features.
- **Patch:** backward-compatible fixes and maintenance, including workflow or documentation fixes.

For example, a workflow fix bumps only the project patch version; a web bug fix bumps both patch versions.
A breaking CLI change bumps the project major version without requiring an app version change.
Scheduled refreshes of external data do not bump either software version; data can change between builds
of the same software release.

### Preparing a release

1. Bump the project version in `Cargo.toml` when preparing the release, rather than on every commit.
   Refresh and commit the workspace package versions in `Cargo.lock`. Bump the app version if applicable.
   Include the project bump for releases containing only workflow or documentation changes so CD runs.
2. Merge the release into `master`. CD builds and tests that commit, then creates the missing project tag
   and, when the app version is new, its web tag on that same commit. An unchanged app keeps its existing tag.
3. Create GitHub releases from those tags using the titles above. Project release notes identify the
   included app version; app release notes identify the containing project release. Mark the project
   release as **Latest**. GitHub release titles do not introduce another version number.
4. Keep published tags fixed. Corrections receive new versions.

Preserve historical `cli-v*` and `web-v*` tags and releases. Future project tags use `v*`; the first release
under this policy should increase the project version beyond the existing `1.0.0`, rather than renaming
`cli-v1.0.0` or reusing that version for a different project snapshot.

### Current automation limits

The tag naming supports this policy, but the existing workflows do not enforce all of it:

- CD creates missing tags without validating version increases, requiring a project bump for an app
  release, or checking whether an existing tag points to the intended commit. Review these before release.
- GitHub release creation, release notes, and the **Latest** designation are manual.
- Pages deploys `master` independently of CD, including scheduled refreshes. It does not ensure that
  production or monthly data refreshes use the latest successfully released project commit.

## Generating data and configuring seasons

```powershell
# Explicit historical training period and target season
cargo run --release -p history-importer -- --through-season 2025
cargo run --release -p elo-ratings -- --target-season 2026

# Alternate league configuration and output folder
cargo run --release -p history-importer -- --config config/example.json --data-dir data-example
cargo run --release -p elo-ratings -- --config config/example.json --data-dir data-example

# Import a previously downloaded provider file
cargo run --release -p history-importer -- --input C:/path/to/games.csv
```

The `example.json` filename above illustrates how to supply your own configuration; no fictional league is
configured by default. `config/nfl.json` is the included production configuration, published to the site and
read by the browser at `config/nfl.json`.

For each new NFL season, run the importer and Elo calculator again and rebuild the site. The importer is
intentionally restricted to historical seasons. A new season's current data belongs only to the browser app.

Imported games are ordered chronologically using UTC start times. The importer reports missing-time and
daylight saving adjustments on stderr and rejects games whose dates cannot be resolved. See
[docs/extending.md](docs/extending.md) for timestamp rules and data formats.

### Text files and ownership

Generated history and Elo outputs are readable, formatted JSON under `data/<league>/`:

| File | Written by | Contents |
| --- | --- | --- |
| `history.json` | Rust importer | Normalized games and reported outcomes through the season before the target season, plus the effective-season franchise identity registry |
| `elo-<target-season>.json` | Rust Elo calculator | Preseason ratings for the target season, model settings, source/configuration hashes, tie parameter, per-game Elo audit |

By default, the season is selected from the current UTC date using the configured rollover month (April
for the included NFL configuration). Use `--through-season` with the importer, `--target-season` with
the Elo calculator, and `--season` with the Node backtest to override their defaults.

The importer and Elo calculator hold OS-released file locks while writing. They write a temporary file
in the same directory, flush it, and atomically replace the destination. Data files are ignored by Git
and regenerated by the Pages workflow.

## Making changes

Editing model configuration or replacing history requires rerunning `elo-ratings`, because the files are
linked by SHA-256 hashes. After editing franchise identities or aliases, rerun the importer first, then
Elo, so the history's identity registry matches the configuration and the seed records the updated hashes.
Rebuild the site to publish the updated files.

Brand direction and approved messaging are in [docs/branding.md](docs/branding.md).

### Checks

Run the format, lint, test, and build checks used by CI:

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm -C apps/web lint
pnpm -C apps/web format:check
pnpm -C apps/web test
pnpm -C apps/web build
```

Generate TypeDoc documentation with `pnpm -C apps/web run docs`. The explicit `run` is required:
pnpm 12 has its own `docs` subcommand that shadows the script.

### Browser cache and refresh behavior

The browser stores current-season games, the fitted model, and displayed predictions in `localStorage`.
Returning visits show compatible saved results before any network request. A Web Worker checks for updates
and rebuilds when the app version, normalized current-season game data, eligible result count, configuration,
or published Elo seed differs. Changes to CSV formatting, row order, or scores that do not change the outcome do not trigger
a rebuild. A notification remains visible during rebuilding, and compatible old results remain usable
until the complete replacement is ready. Failed updates retain compatible predictions with a warning.
The page shows when its displayed data was retrieved and when it was last successfully checked; these
are browser timestamps, not the provider's publication time.

A refresh-attempt timestamp is saved before work starts. Rapid reloads wait until 60 seconds after that
attempt before checking again, including after an interrupted attempt. Web Locks coordinate tabs where
supported; the cache and cooldown are rechecked after acquiring the lock. Without Web Locks, the cooldown
still limits sequential reloads, but simultaneous tabs can race. HTTP revalidation can avoid downloading
unchanged CSV, Elo seed, and history bodies when the browser has cached responses and the server supports
conditional requests. Unloading terminates the worker; unfinished work may need to restart after the
cooldown. After the load's check completes, there is no periodic polling.
Unavailable or full browser storage prevents persistence across reloads; the app still runs without it.

Configuration changes trigger a rebuild even when current-season games are unchanged. The worker computes
the season on each load and only reuses a model snapshot for the matching league and season. A new season
requires its schedule and matching published history/Elo seed. The page may retain the previous season's
saved display with a warning if the new season cannot be loaded.

Every successful refresh validates the published seed's league, season, configuration hash, and history
hash before reusing a model. Seed and history requests use `cache: 'no-cache'` to revalidate HTTP cache
entries. Their response bodies are hashed on each check, even when revalidation avoids transferring them.
A SHA-256 hash of the exact seed bytes is stored as `seed_sha256` in the model snapshot. Changed seed bytes
trigger a rebuild, including a regenerated seed with a new history hash; mismatched history and seed files
fail the update and preserve the previous snapshot. Unchanged validated inputs and result eligibility skip model fitting.
Snapshots with the current app version but no seed fingerprint still display immediately and rebuild on
their first successful refresh to acquire one.

Each model snapshot stores `app_version`. The shared snapshot reader rejects missing, different, or malformed
versions before restoring a model, both on the page (including after acquiring the refresh lock) and in the
worker's service. Incompatible snapshots remain stored until a complete replacement succeeds, but their
models and predictions are not used. Valid raw game caches remain reusable after their existing validation.
Failed upgrades preserve the old snapshot and validated raw games for retry and show an error; only
compatible snapshots can supply fallback predictions. Successful builds write the running app version.

Each check computes eligible results using the current time and compares their count with the snapshot's
`training_games`. NFL results becoming eligible at midnight Eastern trigger a rebuild even when normalized
games are unchanged. Crossing midnight without a change in eligibility does not trigger model fitting.
Kickoff/status changes alone still do not invalidate a snapshot. Clear the site's saved data to force
an initial build with the current inputs. Cache, refresh-lock, and cooldown keys in
`session.ts` and `snapshot.ts` currently assume the single NFL browser app; see
[browser wiring](docs/extending.md#wire-the-browser) before adding leagues.

The app never modifies historical data or Elo files. Rebuilds use the original priors and the current set
of results, so reloads do not double-count games. Corrected outcomes take effect on the next successful
update. A source response that drops an already completed game is rejected, preserving the previous
snapshot.

## Elo tuning commands

`elo-tune` reads the existing `data/nfl/history.json` once and runs entirely offline. It searches
`elo.k`, `elo.home_advantage`, and `elo.offseason_regression`, using the same chronological Elo replay as
`elo-ratings`. It prints a JSON report to stdout and progress to stderr. It does not use published Elo seeds,
fit a Bayesian model, estimate tie probabilities, or modify any input files.

```powershell
cargo run --release -p elo-tune

# Also save a report named with the league and UTC run date
cargo run --release -p elo-tune -- --report-dir target

# Explicit paths and chronological split (these are the defaults)
cargo run --release -p elo-tune -- --config config/nfl.json --data-dir data --tune-start 2010 --tune-end 2022 --test-end 2025
```

`--report-dir` creates the directory if needed and saves `elo-tuning-report-<league>-<YYYY-MM-DD>.json`,
for example `target/elo-tuning-report-nfl-2026-09-26.json`. The date comes from the report's UTC `run_at`
timestamp. Another run for the same league and date replaces that report. JSON is still printed to stdout.

The league config's `elo_tune` section supplies `tune_start`, `tune_end`, and `test_end`; the corresponding
CLI options override them individually. Without `elo_tune`, all three CLI options are required.

See [Elo-only tuning](docs/model.md#elo-only-tuning) for the selection method, evaluation split, and report contents.

## Bayesian tuning commands

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

Elo replay and historical matchup differences are cached across candidates; tie weights are cached by
smoothing pair. The Rust model matches the browser's Davidson likelihood, Laplace covariance, and Simpson
integration, with a shared numerical fixture tested in both languages.

JSON goes to stdout; progress goes to stderr. `--report-dir` also writes
`bayes-tuning-report-<league>-<UTC run date>.json`, replacing a same-day report for that league.
After changing parameters, regenerate Elo seeds because configuration hashes and tie weights must agree.
See [Bayesian parameter tuning](docs/model.md#bayesian-parameter-tuning) for the search method and report contents.

## Bayesian backtesting

The included backtest predicts each game using only results from earlier **UTC dates**. Outcomes on the same
UTC date cannot leak into predictions, even when the source uses mixed timezones. It reports multiclass
Brier score and natural-log loss against an equal-strength baseline. It runs in Node, reading configuration,
history, and the Elo seed from disk, then downloading the evaluated season's games from the configured
provider. Unlike the Rust tuning commands, it requires network access and has no `--input` option.

```powershell
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

Keep permanent franchise IDs when teams move or change names, and update their season-based identity eras
and source aliases. See [docs/team-history.md](docs/team-history.md) for identity ranges and validation rules.
