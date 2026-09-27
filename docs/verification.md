# Verification record

## Upstream project, 2026-09-19

Verified in a Linux environment with Rust 1.98.1, Node 24.19.0, and pnpm 11.19.0, against the standalone
`game-results-prediction` project — a Node HTTP server serving a React client over a local `/api`.

### Passed checks before the port

- Rust formatting and Clippy with warnings treated as errors.
- 9 Rust tests covering Elo, source parsing, chronological boundaries, franchise identity eras, and rating continuity across relocation.
- 21 TypeScript tests covering the Bayesian posterior, ties, symmetry, season boundaries, data validation, cache behavior, corrections, duplicate rejection, and historical identities.
- TypeScript strict type checking and Vite production build.
- Frozen-lockfile pnpm installation; no release-age policy exceptions in the delivered workspace.
- Real HTTPS download of the nflverse source by the Rust importer using system-trusted TLS certificates.
- Import and Elo calculation for 6,499 regular/postseason games from 2002 through 2025, including 15 ties and 32 franchise priors for 2026.
- Exact Rust/TypeScript normalization agreement on all 6,499 records, including byte-consistent ordering, original source abbreviations, and stable franchise IDs.
- Live TypeScript startup refresh for 2026, with 17 eligible results at verification time.
- Chronological backtest command executed successfully on the available 2026 results. This small diagnostic run is not a validation of forecast calibration or predictive superiority.
- Production-mode browser checks at 1440×1100 and 390×844: matchup selectors, neutral-site effects, zero NFL playoff tie probability, completed-game list, franchise-history table, invalid API input rejection, no JavaScript errors, and no horizontal page overflow on mobile.
- Desktop and mobile screenshots visually inspected.

## Port into Capper Zone, 2026-09-19

The project was imported into this repository and the TypeScript application was converted from a Node
server with an HTTP API into a **static browser app** published to GitHub Pages. The model, the provider
adapters, and the service now run in the browser; the Rust programs' output is published as static assets.
Verified on Windows 11 with MSVC, Rust stable (edition 2024), Node 22.15.0, and pnpm 10.20.0.

### Passed checks after the port

- Rust formatting, Clippy with warnings as errors, and 7 Rust integration tests on edition 2024.
- 22 TypeScript tests, including the rewritten service tests that drive the browser storage and static-asset fetch paths.
- ESLint (including `react-hooks`), Prettier, TypeScript strict type checking, and the Vite production build.
- Live HTTPS import and Elo calculation: 6,499 games from 2002–2025, 15 ties, 32 priors for 2026.
- End-to-end run of the browser code path against the built `dist/` served over HTTP: configuration and seed
  hashes verified, live nflverse refresh applied, 17 eligible 2026 results fitted, predictions produced.
- Backtest script executed against the published data and the live source.

### Not re-verified after the port

- Rendered-browser checks and screenshots. The React components were carried over unchanged apart from the
  data-loading effect; the visual layer has not been re-inspected at the two viewport sizes.

## Dependency upgrade, 2026-09-19

All dependencies and toolchains taken to the latest stable release, accepting breaking changes.

### Applied

- `reqwest` 0.12 → 0.13. The `rustls-tls-native-roots` feature was split; the crate now requests
  `rustls` plus `rustls-native-certs` for the same OS-trust-store behavior.
- `sha2` 0.10 → 0.11. `Sha256::digest` now returns a `hybrid_array::Array`, which no longer implements
  `LowerHex`, so `rating_core::digest` hex-encodes byte by byte.
- pnpm 10.20.0 → 12.4.2. Settings moved out of the `pnpm` field in `package.json` into
  `apps/web/pnpm-workspace.yaml`, ignored install scripts became a hard error, and the lockfile is now
  verified against a supply-chain release-age policy.
- All other npm dependencies re-resolved to their latest published versions.

### Held back

- **TypeScript stays at 6.x.** TypeScript 7.0.2 type-checks this project cleanly, but `typescript-eslint`
  8.70.0 — stable and canary alike — declares `typescript >=4.8.4 <6.1.0` and refuses to load with
  `typescript-eslint does not support TS 7.0`, and `typedoc` 0.28.20 crashes on the TS 7 API. `pnpm lint`
  and `pnpm run docs` both fail. Tracked upstream at typescript-eslint issue 10940.

### Re-verified after the upgrade

- Rust: fmt, Clippy with warnings as errors, 9 tests.
- Web: 22 tests, `tsc`, ESLint, Prettier, production build, TypeDoc, backtest.
- Live HTTPS import over the new rustls feature set: 6,499 games, 15 ties, 32 priors for 2026, with the
  Rust SHA-256 digests still matching the browser's WebCrypto digests.
- End-to-end browser code path against the built site: identical predictions to the pre-upgrade run.

## Elo-only tuning, 2026-09-26

- Added the offline `elo-tune` CLI. Configuration, source history, and published Elo seeds remain unchanged.
- Shared the chronological Elo replay between `elo-ratings` and `elo-tune`; Bayesian fitting and Davidson
  tie-weight estimation are absent from the tuner.
- Rust workspace: 15 tests pass; formatting and Clippy with warnings treated as errors pass.
- Tests cover pre-update scoring, ties, offseason boundaries, equal season weighting, conservative candidate
  selection, input validation, repeatability, unchanged input files, independence from held-out outcomes
  during selection, and independence from Bayesian parameter values.
- On the existing 6,499-game dataset, the shared replay reproduces all previous audit entries, team ratings,
  and tie weight exactly. The existing seed's configuration hash corresponds to LF line endings; the current
  checkout uses CRLF. Verification compared numerical output separately and did not rewrite that seed.
- The 2010–2022 search evaluated 472 combinations after expansion and refinement. Its conservative selection
  was K = 40, home advantage = 45, and offseason regression = 0.3833333333333333. The lowest tuning MSE
  occurred at K = 45, home advantage = 45, and regression = 0.43333333333333335.
- Selected versus existing settings: tuning mean-season MSE 0.2227607921 versus 0.2260192987; held-out
  2023–2025 mean-season MSE 0.2226960475 versus 0.2270675604, a 1.93% relative improvement. Performance
  worsened in 2023 and improved in 2024 and 2025. Three held-out seasons do not establish general superiority.
- These values are reported results, not changes to the production configuration. The CLI emits the full
  per-season evaluation, calibration bins, search summary, and input hashes as JSON.

## UTC history normalization, 2026-09-26

- Historical imports store an authoritative UTC start time with no `date`, `time`, or `timezone`.
  Source-local conversion and warnings run only in the importer. Elo replay and tuning use the stored UTC
  timestamp; schema 1 histories require reimporting. The current-season browser retains local fields.
- Regression fixtures cover seasonal offsets, UTC date rollover, mixed-timezone shared-team replay,
  deterministic DST overlaps, missing times, DST gaps, unknown zones, missing dates, and skipped dates.
- The importer CLI test verifies warnings on stderr, UTC-only output even when a provider supplies a
  conflicting timestamp, and preservation of the previous history file when a source date is missing.
- Historical reader tests verify UTC-only round trips and replay, disregard for obsolete local fields,
  rejection of missing or malformed UTC timestamps, and actionable errors for obsolete history files.
- Backtest regression verifies that training uses only earlier UTC dates, excluding same-day and
  simultaneous outcomes even when local dates disagree.
- Passed: 24 Rust tests, Clippy with warnings as errors, Rust formatting, 34 web tests, ESLint, Prettier,
  TypeScript strict checking, and the Vite production build.

## League-independent game fields, 2026-09-27

- Shared contracts use `start_time_utc`, numeric `round`, and `round_label`. Historical output is schema 3;
  canonical provider responses and browser caches are schema 2. Configuration and Elo seeds remain schema 1.
- NFL source columns and page labels retain football terminology. Adapter tests verify that numeric rounds
  and provider labels remain separate, and existing Super Bowl completeness checks use `round_label`.
- Tests reject obsolete history/provider versions and invalid round indices. An obsolete browser cache is
  preserved on a failed refresh and replaced with schema 2 after a successful download.
- Migrated the local 6,499-game history with a backup and regenerated its 2026 Elo seed. Every game value,
  rating, audit entry, and tie value is unchanged; the new history and configuration hashes match the seed.
- Passed: 24 Rust tests, Clippy with warnings as errors, Rust formatting, 38 web tests, ESLint, Prettier,
  TypeScript strict checking, the Vite production build, and TypeDoc generation.

## Scope

The repository contains code, configuration, lockfiles, tests, documentation, and GitHub Actions workflows.
Installed dependencies, compiled binaries, and generated game data are excluded. Follow the README to
download data and regenerate ratings on your machine.

The data source and its contents can change after verification. The model settings are configurable starting
values and have not been optimized on a separate validation dataset. The deliberate next-day result rule for
the NFL source is documented in the README and in the app.
