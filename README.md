# Rally Row

<img src="docs/branding/production/svg/rally-row-tagline-on-navy.svg" alt="Rally Row. A little insight. A lot to talk about." width="640">

[![CI (Rust)](https://github.com/jambolo/rally-row/actions/workflows/ci-rust.yml/badge.svg?branch=develop)](https://github.com/jambolo/rally-row/actions/workflows/ci-rust.yml?query=branch%3Adevelop)
[![CI (Web)](https://github.com/jambolo/rally-row/actions/workflows/ci-web.yml/badge.svg?branch=develop)](https://github.com/jambolo/rally-row/actions/workflows/ci-web.yml?query=branch%3Adevelop)
[![Coverage (develop)](https://codecov.io/gh/jambolo/rally-row/branch/develop/graph/badge.svg)](https://codecov.io/gh/jambolo/rally-row/tree/develop "Coverage on develop")

## Overview

Rally Row helps sports fans see how teams stack up and who's more likely to win. It combines historical
team ratings with the current season's results to estimate each team's chance of winning a matchup.
The included league is the NFL, covering regular-season and postseason games.

Use it to explore any two teams, compare home and neutral venues, follow the schedule, and see how team
strength estimates change from preseason. Predictions include separate win, loss, and tie probabilities
and an uncertainty range. The app runs in your browser with no account, API key, or subscription required.

## Usage

Open [Rally Row](https://jambolo.github.io/rally-row/) in your browser. The first visit downloads the
published ratings and current-season results and prepares the predictions. Returning visits show saved
results immediately while the app checks for updates.

### Explore a matchup

1. Select **Explore matchups**, then choose two different teams under **Who takes it?**
2. Choose the **Home team** and **Away team**. Use **Swap teams** to reverse them.
3. Check **Neutral venue** for a game with no home advantage; the selectors become **Team A** and **Team B**.
4. Set **Game type** to **Regular season** or **Postseason**. NFL postseason games have zero tie probability.
5. Read each team's chance of winning and the chance of a tie. Expand **How certain is this estimate?**
   for the approximate 95% credible interval for the home team's (or Team A's) win probability.

The probabilities describe possible outcomes, not predicted scores. The uncertainty interval describes
how precisely the model estimates a team's win probability; it is not a range of possible game scores.
Displayed percentages are rounded, so their sum can differ slightly from 100%.

### Follow the season

In **Schedule & results**, filter by **Week** and switch between **Upcoming**, **Completed**, and
**Awaiting result**. Select an upcoming game's prediction to load its teams, venue, and game type into
the matchup controls. Completed games show the actual result alongside the reconstructed pregame favorite
and its win probability, using only results from earlier dates.

The **Team ratings** table compares preseason and current strength estimates. Higher ratings indicate a
stronger estimated team; **± uncertainty** is one standard deviation of the current strength estimate,
not the matchup's 95% probability interval. Expand **Franchise names and locations over time** to see
how renamed or relocated teams retain their rating history.

### Updates and saved results

The status card shows **Data retrieved** and **Last checked**. These are your browser's timestamps, not
the data provider's publication time. Saved results remain usable while an update is being prepared.
If an update fails, the app retains the previous snapshot and displays a warning.

**NFL results enter the model on the following calendar day in Eastern Time.** The source has no
authoritative live/final flag, so today's scores are deliberately excluded. A game may remain under
**Awaiting result** until it is eligible and the provider has published its outcome. Provider delays
can extend this wait.

The app checks on page load, with a one-minute cooldown between attempts. Reload to check again; an open
page does not poll periodically. Corrections to eligible outcomes and updates to published preseason
ratings or historical data are incorporated on a successful update.
Saved data belongs to the current browser. If browser storage is unavailable or full, the app still runs
but cannot preserve results across reloads.

The season is selected automatically on page load. After a season rollover, a successful update requires
the new season's published preseason ratings and schedule. If those are unavailable, saved results may
remain visible with a warning.

Some changes do not automatically invalidate saved predictions, including the date crossing midnight
or an updated model implementation.
If predictions remain stale after a successful check, clear the site's saved data in your browser and
reload to rebuild from the current published inputs.

For local setup, building, and contributing, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Methodology

Rally Row builds preseason Elo ratings from NFL regular-season and postseason results since 2002.
Offseason regression moves ratings toward the league average while preserving each franchise's history.

A Bayesian model starts from those ratings and updates team strength estimates using eligible
current-season wins, losses, and ties. It accounts for opponent strength, home advantage, neutral venues,
tie rules, and uncertainty to produce matchup probabilities.

The model does not use score margins, injuries, rosters, or betting markets. Predictions are estimates,
not guarantees. Evaluation tools use chronological backtests and separate tuning and held-out seasons.

See [Statistical model](docs/model.md) for data sources, formulas, model settings, parameter selection,
and limitations.
