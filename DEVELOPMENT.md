# Development

## Local setup

Use Node LTS, stable Rust with `rustfmt` and `clippy`, and the pnpm version pinned in
[`apps/web/package.json`](apps/web/package.json). On Ubuntu, Rust dependencies also need
`build-essential`, `pkg-config`, and `ca-certificates`.

Run commands from the repository root:

```powershell
pnpm -C apps/web install --frozen-lockfile
cargo run --release -p history-importer
cargo run --release -p elo-ratings
pnpm -C apps/web dev
```

Subsequent runs need only `pnpm -C apps/web dev` unless data or configuration changes.
Local Vite and Pages use `/rally-row/`. Set `VITE_BASE` to override it locally.

Dependency install-script permissions and release-age exceptions are in
[`apps/web/pnpm-workspace.yaml`](apps/web/pnpm-workspace.yaml).

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

## Data and configuration

The included league configuration is [`config/nfl.json`](config/nfl.json). Generated files are ignored
by Git: `data/nfl/history.json` from the importer and `data/nfl/elo-<target-season>.json` from Elo.
Season defaults use the current UTC date and the configured rollover month (April for NFL).

```powershell
cargo run --release -p history-importer -- --through-season 2025
cargo run --release -p elo-ratings -- --target-season 2026

# Custom configuration and output directory
cargo run --release -p history-importer -- --config config/example.json --data-dir data-example
cargo run --release -p elo-ratings -- --config config/example.json --data-dir data-example

# Previously downloaded provider file
cargo run --release -p history-importer -- --input C:/path/to/games.csv
```

`config/example.json` is a placeholder for your own configuration.

- New season: rerun the importer and Elo, then rebuild the site. Import only historical seasons.
- Model configuration or history changes: rerun Elo to update the linked hashes.
- Franchise identity or alias changes: rerun the importer, then Elo.

Rebuild the site to publish updated data and configuration.

## Checks

```powershell
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm -C apps/web lint
pnpm -C apps/web format:check
pnpm -C apps/web test
pnpm -C apps/web build
```

Generate TypeDoc with `pnpm -C apps/web run docs`; `run` avoids pnpm 12's built-in `docs` command.
Clear the site's saved data to force a fresh model build during development.

## Building and publishing

```powershell
pnpm -C apps/web build      # apps/web/dist
pnpm -C apps/web preview
```

For hosting at a domain root:

```powershell
$env:VITE_BASE = '/'
pnpm -C apps/web build
```

Workflows in [`.github/workflows/`](.github/workflows/):

- `ci-rust.yml` and `ci-web.yml`: builds and tests on Ubuntu and Windows for pushes to `master`,
  `develop`, and `release/**`, and for pull requests. Lint and formatting run on pull requests;
  Codecov uploads run on `develop` with `rust` and `web` flags.
- `cd.yml`: runs when either version manifest changes on `master`. After builds and tests, creates
  missing project and web tags, then merges `master` into `develop` if it created a tag.
- `pages.yml`: regenerates history and Elo, builds the site with `data/` and `config/`, and deploys
  `apps/web/dist`. Runs on `master` pushes, manual dispatch, and the first Tuesday of each month at
  09:17 UTC. Deployment is independent of CD and is not gated on a successful release.

### Versions and releases

| Scope | Version source | Tag | GitHub release title |
| --- | --- | --- | --- |
| Project | `Cargo.toml`: `[workspace.package].version` | `vX.Y.Z` | `Rally Row X.Y.Z` |
| Web app | `apps/web/package.json`: `version` | `web-vA.B.C` | `Rally Row Web A.B.C` |

Bump the project version for every release, including web-only, workflow, or documentation changes,
and refresh the workspace versions in `Cargo.lock`. All Rust crates inherit the project version.
Bump the web version for app changes; every web release also requires a project bump. Data-only
refreshes need neither bump.

The web version also controls model-cache compatibility. Bump it before deploying prediction or
snapshot-format changes, including dependencies that affect either. Every web version change
invalidates saved models; a project-only bump does not. Pages does not enforce this requirement.

Merge releases into `master` for CD to tag them. Create GitHub releases manually using the titles
above, cross-reference the project and app versions in their notes, and mark the project release
as **Latest**. CD does not validate version increases, required project bumps, or existing tag targets.

Preserve published tags, including historical `cli-v*` and `web-v*` tags and releases. The first `v*`
project release must exceed `1.0.0` rather than reuse the historical `cli-v1.0.0` version.

## Tuning

Both tuners run offline against `data/nfl/history.json` without modifying inputs. `elo-tune` searches
Elo parameters; `bayes-tune` searches Bayesian parameters with Elo fixed. Methods and report contents:
[Elo tuning](docs/model.md#elo-only-tuning) and
[Bayesian tuning](docs/model.md#bayesian-parameter-tuning).

```powershell
cargo run --release -p elo-tune
cargo run --release -p bayes-tune

# Save reports
cargo run --release -p elo-tune -- --report-dir target
cargo run --release -p bayes-tune -- --report-dir target

# Path and split overrides (also supported by bayes-tune)
cargo run --release -p elo-tune -- --config config/nfl.json --data-dir data --tune-start 2010 --tune-end 2022 --test-end 2025
```

JSON reports go to stdout; progress goes to stderr. `--report-dir` also writes
`elo-tuning-report-<league>-<YYYY-MM-DD>.json` or `bayes-tuning-report-<league>-<YYYY-MM-DD>.json`
using the UTC run date. Same-day runs replace the corresponding report.

Split defaults come from `elo_tune` or `bayes_tune` in the league configuration; `bayes_tune` falls
back to `elo_tune`. CLI options override individual boundaries. Without configuration defaults,
all three boundaries are required. Splits require at least one warm-up season, two tuning seasons,
and one later completed held-out season.

After applying tuned parameters, regenerate Elo seeds and rebuild the site.

## Backtesting

The Node backtest reads local history and Elo seeds, then downloads the evaluated season's games.
It requires network access and has no `--input` option.

```powershell
# Evaluate 2025 with priors trained through 2024
cargo run --release -p history-importer -- --through-season 2024 --data-dir data-backtest
cargo run --release -p elo-ratings -- --target-season 2025 --data-dir data-backtest
pnpm -C apps/web backtest -- --season 2025 --data-dir data-backtest
```

## References

- [Browser usage](README.md)
- [Statistical model and backtesting methodology](docs/model.md)
- [Adding leagues, data formats, and browser wiring](docs/extending.md)
- [Franchise identities and aliases](docs/team-history.md)
- [Branding and messaging](docs/branding.md)
- [Verification record](docs/verification.md)
