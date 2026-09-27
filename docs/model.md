# Statistical model

Only game outcomes, opponent identities, season boundaries, and venue are model inputs. Scores are used by the source adapter to derive outcomes and are then discarded.

## Historical Elo

For home team h and away team a, with ratings R, scale s, and home advantage H:

```math
E_h = \frac{1}{1 + 10^{(R_a-R_h-H)/s}}
```

H is zero at a neutral venue. The observed score S is 1 for a home win, 0 for an away win, and 1/2 for a tie. Ratings update simultaneously:

```math
R'_h = R_h + K(S-E_h), \qquad R'_a = R_a - K(S-E_h).
```

`E_h` is an expected fractional game score, not a separately modeled probability of a home win when ties are possible. The historical Elo system uses ties correctly without estimating three outcome probabilities.

Games are sorted by season, UTC start time, and game ID. The importer converts source-local dates and times using IANA timezone rules, then discards the local fields. Historical readers require schema version 3 and use the stored `start_time_utc` as authoritative; they never reconstruct it from local fields. Missing times and times in a daylight saving gap use local midnight; ambiguous times use the earlier occurrence. The importer warns for each fallback or ambiguity and rejects missing dates. If local midnight itself does not exist, conversion fails. Before each new season, and once before the target season, regression r is applied:

```math
R_{new} = R_0 + (1-r)(R_{old}-R_0).
```

This keeps very old results from dominating indefinitely. All historical wins and losses remain in the chronological training sequence. The audit records each game's before/after ratings, predicted fractional score, and observed score. Preseason ratings cannot include target-season results; file season boundaries and hashes are checked.

## Bayesian prior

Let `c = ln(10) / s`. Each team's latent strength has independent prior

```math
\theta_i \sim N(c(R_i-R_0), (c\sigma_R)^2).
```

The means come from the Rust preseason Elo file. `sigma_R = 150` Elo points is the configurable initial uncertainty, not the team's historical standard error. Historical Elo alone does not identify a Bayesian prior variance.

## Win, loss, and tie likelihood

For `d = theta_h - theta_a + c H` and positive tie parameter nu, define

```math
D = e^{d/2}+e^{-d/2}+\nu,
\quad P(h\text{ wins}) = e^{d/2}/D,
\quad P(a\text{ wins}) = e^{-d/2}/D,
\quad P(\text{tie}) = \nu/D.
```

This is Davidson's extension of the Bradley–Terry model. Setting nu to zero yields binary Bradley–Terry, equivalent to the Elo logistic relationship at fixed strengths. For NFL postseason games, nu is zero because the phase does not permit ties. All three probabilities sum to one. See R. R. Davidson, *On Extending the Bradley–Terry Model to Accommodate Ties in Paired Comparison Experiments*, Journal of the American Statistical Association, 1970, [DOI: 10.1080/01621459.1970.10481082](https://doi.org/10.1080/01621459.1970.10481082).

The Rust calculator estimates nu from eligible historical games and their pre-game Elo differences. It solves for expected ties equal to observed ties plus a configurable pseudo-count. The smoothing consists of `tie_prior_games` equal-strength pseudo-games with expected tie frequency `tie_prior_rate`. Nu is fixed during the target season; uncertainty in nu is not included in the posterior.

## Posterior and numerical method

The app forms the joint posterior from the preseason priors and the likelihood of each eligible completed game **once**. It maximizes log posterior by damped Newton iterations, then takes the inverse Hessian of the negative log posterior as covariance. The proper Gaussian prior makes the precision matrix positive definite and anchors absolute rating levels. Cholesky factorization is used for solves and the inverse.

The result is a **Laplace approximation**, not exact sampling. It retains the full team covariance matrix. Given the approximation, the matchup difference is normal with

```math
\mu_d = \mu_h - \mu_a + cH,
\quad \sigma_d^2 = \Sigma_{hh} + \Sigma_{aa} - 2\Sigma_{ha}.
```

Predicted outcome probabilities average the likelihood over this normal distribution using deterministic Simpson quadrature over ±8 standard deviations (160 intervals). They are not just probabilities evaluated at the fitted mean. The displayed home-win credible interval transforms the 2.5th and 97.5th percentiles of d through the monotonically increasing home-win function. It describes uncertainty about the home team's win probability, not a range of possible game scores.

The Rust `rating-core::bayesian` implementation uses the same likelihood, optimizer, covariance, and predictive integration as the browser. A shared fixture checks both implementations. `bayes-tune` uses this model for offline chronological parameter search, keeping Elo fixed, regenerating preseason priors and tie weights from earlier seasons, and excluding same-UTC-day outcomes from predictions. It selects by mean season log loss, then evaluates a frozen choice on later held-out seasons. See [Bayesian parameter tuning](../README.md#bayesian-parameter-tuning) for search settings and report contents.

## Limits and validation

- Team strength is modeled as constant within each fitted season. There is no explicit random walk over time, injury adjustment, roster change, rest effect, or recency weighting within that season.
- The covariance and intervals are approximate and conditional on the selected hyperparameters, fixed home advantage, and fixed tie parameter. They do not include all sources of forecast uncertainty.
- Elo K, home advantage, regression, and prior variance are editable starting choices. They have not been optimized or claimed to outperform another forecasting model.
- Historical continuity across a franchise relocation is a deliberate team-identity rule, not a claim of unchanged roster quality.
- The default data provider does not expose an authoritative live/final flag. The app waits until the following local calendar date before using a reported outcome and accepts later corrections at the next startup.
- Backtests refit using earlier dates only. Evaluate held-out seasons and calibration before drawing conclusions about model quality.

Unit tests cover symmetry, probability normalization, neutral-site handling, proper tie outcomes, posterior updates, an analytic two-team Hessian/covariance case, duplicate rejection, and repeatable refits. Integration tests cover provider normalization, cache fallback, corrected results, stale priors, and season boundaries.
