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

## Scope

The repository contains code, configuration, lockfiles, tests, documentation, and GitHub Actions workflows.
Installed dependencies, compiled binaries, and generated game data are excluded. Follow the README to
download data and regenerate ratings on your machine.

The data source and its contents can change after verification. The model settings are configurable starting
values and have not been optimized on a separate validation dataset. The deliberate next-day result rule for
the NFL source is documented in the README and in the app.
