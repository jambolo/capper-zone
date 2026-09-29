use anyhow::{Context, Result};
use rating_core::{
    BayesianGrid, BayesianSettings, EloSeed, EloSettings, Game, GameFile, LeagueConfig, Outcome,
    bayesian::{Probabilities, TieHistory, fit_posterior},
    build_seed,
    tuning::{Split, validate},
};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Parameters {
    pub prior_sd_elo: f64,
    pub tie_prior_games: f64,
    pub tie_prior_rate: f64,
}

impl Parameters {
    fn from_settings(s: &BayesianSettings) -> Self {
        Self {
            prior_sd_elo: s.prior_sd_elo,
            tie_prior_games: s.tie_prior_games,
            tie_prior_rate: s.tie_prior_rate,
        }
    }
    fn settings(self) -> BayesianSettings {
        BayesianSettings {
            prior_sd_elo: self.prior_sd_elo,
            tie_prior_games: self.tie_prior_games,
            tie_prior_rate: self.tie_prior_rate,
        }
    }
    fn distance(self, baseline: Self) -> f64 {
        (self.prior_sd_elo / baseline.prior_sd_elo).ln().powi(2)
            + (self.tie_prior_games / baseline.tie_prior_games).ln().powi(2)
            + (self.tie_prior_rate / baseline.tie_prior_rate).ln().powi(2)
    }
}

#[derive(Clone, Serialize)]
pub struct Grid {
    prior_sd_elo: Vec<f64>,
    tie_prior_games: Vec<f64>,
    tie_prior_rate: Vec<f64>,
}

impl Grid {
    fn coarse() -> Self {
        Self {
            prior_sd_elo: vec![50.0, 75.0, 100.0, 150.0, 200.0, 300.0],
            tie_prior_games: vec![10.0, 30.0, 100.0, 300.0, 1000.0],
            tie_prior_rate: vec![0.001, 0.0025, 0.005, 0.01],
        }
    }
    /// The league's configured starting grid if present, else the default coarse grid, with its source label.
    fn starting(configured: Option<&BayesianGrid>) -> (Self, &'static str) {
        match configured {
            Some(g) => (
                Self {
                    prior_sd_elo: g.prior_sd_elo.clone(),
                    tie_prior_games: g.tie_prior_games.clone(),
                    tie_prior_rate: g.tie_prior_rate.clone(),
                },
                "config",
            ),
            None => (Self::coarse(), "default"),
        }
    }
    fn candidates(&self) -> Vec<Parameters> {
        let mut result = Vec::new();
        for &prior_sd_elo in &self.prior_sd_elo {
            for &tie_prior_games in &self.tie_prior_games {
                for &tie_prior_rate in &self.tie_prior_rate {
                    result.push(Parameters {
                        prior_sd_elo,
                        tie_prior_games,
                        tie_prior_rate,
                    });
                }
            }
        }
        result
    }
    fn around(center: Parameters) -> Self {
        let neighbors = |v: f64| vec![v / std::f64::consts::SQRT_2, v, v * std::f64::consts::SQRT_2];
        Self {
            prior_sd_elo: neighbors(center.prior_sd_elo),
            tie_prior_games: neighbors(center.tie_prior_games),
            tie_prior_rate: neighbors(center.tie_prior_rate).into_iter().filter(|r| *r < 1.0).collect(),
        }
    }
}

struct PreparedSeason {
    seed: EloSeed,
    games: Vec<Game>,
    ties: TieHistory,
    tie_weights: Vec<(f64, f64, f64)>,
}

fn prepare(history: &GameFile, cfg: &LeagueConfig, start: i32, end: i32) -> Result<Vec<PreparedSeason>> {
    (start..=end)
        .map(|season| {
            let previous = GameFile {
                through_season: season - 1,
                games: history.games.iter().filter(|g| g.season < season).cloned().collect(),
                ..history.clone()
            };
            let mut seed = build_seed(&previous, b"", cfg, b"", season)?;
            let ties = TieHistory::from_audit(&seed.audit, &previous.games, cfg)?;
            seed.audit.clear();
            let mut games: Vec<_> = history.games.iter().filter(|g| g.season == season).cloned().collect();
            games.sort_by(|a, b| a.start_time_utc.cmp(&b.start_time_utc).then(a.id.cmp(&b.id)));
            Ok(PreparedSeason {
                seed,
                games,
                ties,
                tie_weights: Vec::new(),
            })
        })
        .collect()
}

struct PredictionRow {
    probabilities: Probabilities,
    outcome: Outcome,
}

fn predict_season(season: &mut PreparedSeason, cfg: &LeagueConfig) -> Result<Vec<PredictionRow>> {
    let b = &cfg.bayesian;
    let weight = season
        .tie_weights
        .iter()
        .find(|(games, rate, _)| *games == b.tie_prior_games && *rate == b.tie_prior_rate);
    season.seed.tie_weight = if let Some(&(_, _, weight)) = weight {
        weight
    } else {
        let weight = season.ties.estimate(b);
        season.tie_weights.push((b.tie_prior_games, b.tie_prior_rate, weight));
        weight
    };
    let mut predictions = Vec::with_capacity(season.games.len());
    let mut start = 0;
    while start < season.games.len() {
        let date = season.games[start].start_time_utc.date_naive();
        let mut end = start + 1;
        while end < season.games.len() && season.games[end].start_time_utc.date_naive() == date {
            end += 1;
        }
        let model = fit_posterior(&season.seed, &season.games[..start], cfg)
            .with_context(|| format!("Fit season {} before {date}", season.seed.target_season))?;
        for g in &season.games[start..end] {
            predictions.push(PredictionRow {
                probabilities: model.predict(&g.home_team, &g.away_team, g.neutral, &g.phase)?,
                outcome: g.result.clone().context("Cannot score an unreported game")?,
            });
        }
        start = end;
    }
    Ok(predictions)
}

#[derive(Clone, Serialize)]
pub struct Score {
    games: usize,
    log_loss: f64,
    brier: f64,
    expected_ties: f64,
    observed_ties: usize,
}

fn score(rows: &[PredictionRow]) -> Option<Score> {
    if rows.is_empty() {
        return None;
    }
    let mut log_loss = 0.0;
    let mut brier = 0.0;
    let mut expected_ties = 0.0;
    let mut observed_ties = 0;
    for row in rows {
        log_loss -= row.probabilities.for_outcome(&row.outcome).max(1e-15).ln();
        for outcome in [Outcome::HomeWin, Outcome::AwayWin, Outcome::Tie] {
            brier += (row.probabilities.for_outcome(&outcome) - f64::from(row.outcome == outcome)).powi(2);
        }
        expected_ties += row.probabilities.tie;
        observed_ties += usize::from(row.outcome == Outcome::Tie);
    }
    Some(Score {
        games: rows.len(),
        log_loss: log_loss / rows.len() as f64,
        brier: brier / rows.len() as f64,
        expected_ties,
        observed_ties,
    })
}

#[derive(Clone, Serialize)]
pub struct SeasonScore {
    season: i32,
    tie_weight: f64,
    overall: Score,
    first_half: Option<Score>,
    second_half: Option<Score>,
}

#[derive(Clone, Serialize)]
pub struct CalibrationBin {
    outcome: Outcome,
    lower: f64,
    upper: f64,
    games: usize,
    mean_probability: f64,
    observed_rate: f64,
}

#[derive(Clone, Serialize)]
pub struct Evaluation {
    games: usize,
    mean_season_log_loss: f64,
    mean_season_brier: f64,
    pooled: Score,
    seasons: Vec<SeasonScore>,
    calibration: Vec<CalibrationBin>,
}

fn evaluate(prepared: &mut [PreparedSeason], cfg: &LeagueConfig, parameters: Parameters) -> Result<Evaluation> {
    let mut cfg = cfg.clone();
    cfg.bayesian = parameters.settings();
    let mut rows = Vec::new();
    let mut seasons = Vec::new();
    for season in prepared {
        let predictions = predict_season(season, &cfg)?;
        let midpoint = predictions.len() / 2;
        seasons.push(SeasonScore {
            season: season.seed.target_season,
            tie_weight: season.seed.tie_weight,
            overall: score(&predictions).context("Empty evaluation season")?,
            first_half: score(&predictions[..midpoint]),
            second_half: score(&predictions[midpoint..]),
        });
        rows.extend(predictions);
    }
    let mut calibration = Vec::new();
    for outcome in [Outcome::HomeWin, Outcome::AwayWin, Outcome::Tie] {
        let mut bins = [(0_usize, 0.0, 0_usize); 10];
        for row in &rows {
            let p = row.probabilities.for_outcome(&outcome);
            let bin = &mut bins[((p * 10.0) as usize).min(9)];
            bin.0 += 1;
            bin.1 += p;
            bin.2 += usize::from(row.outcome == outcome);
        }
        for (i, (games, total, observed)) in bins.into_iter().enumerate().filter(|(_, b)| b.0 > 0) {
            calibration.push(CalibrationBin {
                outcome: outcome.clone(),
                lower: i as f64 / 10.0,
                upper: (i + 1) as f64 / 10.0,
                games,
                mean_probability: total / games as f64,
                observed_rate: observed as f64 / games as f64,
            });
        }
    }
    Ok(Evaluation {
        games: rows.len(),
        mean_season_log_loss: seasons.iter().map(|s| s.overall.log_loss).sum::<f64>() / seasons.len() as f64,
        mean_season_brier: seasons.iter().map(|s| s.overall.brier).sum::<f64>() / seasons.len() as f64,
        pooled: score(&rows).context("Empty evaluation")?,
        seasons,
        calibration,
    })
}

fn standard_error(values: &[f64]) -> Option<f64> {
    (values.len() >= 2).then(|| {
        let n = values.len() as f64;
        let mean = values.iter().sum::<f64>() / n;
        (values.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0) / n).sqrt()
    })
}

fn differences(baseline: &Evaluation, selected: &Evaluation) -> Vec<f64> {
    baseline
        .seasons
        .iter()
        .zip(&selected.seasons)
        .map(|(a, b)| a.overall.log_loss - b.overall.log_loss)
        .collect()
}

struct Candidate {
    parameters: Parameters,
    evaluation: Evaluation,
}

fn add_candidates(
    candidates: &mut Vec<Candidate>,
    parameters: Vec<Parameters>,
    prepared: &mut [PreparedSeason],
    cfg: &LeagueConfig,
) -> Result<()> {
    for parameters in parameters {
        if candidates.iter().any(|c| c.parameters == parameters) {
            continue;
        }
        let evaluation = evaluate(prepared, cfg, parameters).with_context(|| format!("Evaluate {parameters:?}"))?;
        candidates.push(Candidate { parameters, evaluation });
        if candidates.len().is_multiple_of(10) {
            eprintln!("Evaluated {} Bayesian candidates...", candidates.len());
        }
    }
    candidates.sort_by(|a, b| {
        a.evaluation
            .mean_season_log_loss
            .total_cmp(&b.evaluation.mean_season_log_loss)
    });
    Ok(())
}

fn select(candidates: &[Candidate], baseline: Parameters) -> (&Candidate, usize) {
    let best = &candidates[0];
    let eligible: Vec<_> = candidates
        .iter()
        .filter(|c| {
            c.evaluation.mean_season_log_loss - best.evaluation.mean_season_log_loss
                <= standard_error(&differences(&c.evaluation, &best.evaluation)).unwrap_or(0.0) + 1e-12
        })
        .collect();
    let selected = eligible
        .iter()
        .copied()
        .min_by(|a, b| {
            a.parameters
                .distance(baseline)
                .total_cmp(&b.parameters.distance(baseline))
                .then(
                    a.evaluation
                        .mean_season_log_loss
                        .total_cmp(&b.evaluation.mean_season_log_loss),
                )
        })
        .unwrap();
    (selected, eligible.len())
}

#[derive(Serialize)]
pub struct SeasonDifference {
    season: i32,
    baseline_minus_selected_log_loss: f64,
}

#[derive(Serialize)]
pub struct Comparison {
    baseline: Evaluation,
    selected: Evaluation,
    mean_season_log_loss_improvement: f64,
    paired_season_standard_error: Option<f64>,
    season_differences: Vec<SeasonDifference>,
}

fn compare(baseline: Evaluation, selected: Evaluation) -> Comparison {
    let delta = differences(&baseline, &selected);
    Comparison {
        mean_season_log_loss_improvement: baseline.mean_season_log_loss - selected.mean_season_log_loss,
        paired_season_standard_error: standard_error(&delta),
        season_differences: baseline
            .seasons
            .iter()
            .zip(delta)
            .map(|(s, d)| SeasonDifference {
                season: s.season,
                baseline_minus_selected_log_loss: d,
            })
            .collect(),
        baseline,
        selected,
    }
}

/// Inclusive `[min, max]` of each parameter over every evaluated candidate.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Ranges {
    prior_sd_elo: [f64; 2],
    tie_prior_games: [f64; 2],
    tie_prior_rate: [f64; 2],
}

impl Ranges {
    fn of(evaluated: &[Parameters]) -> Self {
        let range = |value: fn(&Parameters) -> f64| {
            evaluated
                .iter()
                .map(value)
                .fold([f64::INFINITY, f64::NEG_INFINITY], |[lo, hi], v| [lo.min(v), hi.max(v)])
        };
        Self {
            prior_sd_elo: range(|p| p.prior_sd_elo),
            tie_prior_games: range(|p| p.tie_prior_games),
            tie_prior_rate: range(|p| p.tie_prior_rate),
        }
    }
    /// Parameter names, in report key order, whose selected value equals its evaluated minimum or maximum.
    fn boundary(&self, selected: Parameters) -> Vec<&'static str> {
        [
            ("prior_sd_elo", selected.prior_sd_elo, self.prior_sd_elo),
            ("tie_prior_games", selected.tie_prior_games, self.tie_prior_games),
            ("tie_prior_rate", selected.tie_prior_rate, self.tie_prior_rate),
        ]
        .into_iter()
        .filter(|&(_, value, [lo, hi])| value == lo || value == hi)
        .map(|(name, _, _)| name)
        .collect()
    }
}

fn boundary_note(names: &[&str]) -> Option<String> {
    (!names.is_empty()).then(|| {
        format!(
            "Selected parameters lie on a searched boundary ({}); extend tuning_grids in the league configuration and rerun before adopting.",
            names.join(", ")
        )
    })
}

#[derive(Serialize)]
pub struct CandidateSummary {
    parameters: Parameters,
    mean_season_log_loss: f64,
    mean_season_brier: f64,
}

#[derive(Serialize)]
pub struct SearchReport {
    grid_source: &'static str,
    coarse_grid: Grid,
    refinement_centers: Vec<Parameters>,
    refinement_multipliers: [f64; 3],
    candidates_evaluated: usize,
    near_best_candidates: usize,
    minimum_log_loss_parameters: Parameters,
    top_candidates: Vec<CandidateSummary>,
    evaluated_ranges: Ranges,
    selected_on_boundary: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct Report {
    pub run_at: String,
    pub league: String,
    config_sha256: String,
    history_sha256: String,
    method: &'static str,
    selection_rule: &'static str,
    split: Split,
    fixed_elo: EloSettings,
    baseline_parameters: Parameters,
    selected_parameters: Parameters,
    search: SearchReport,
    tuning: Comparison,
    holdout: Comparison,
    notes: Vec<String>,
}

pub fn run(history: &GameFile, cfg: &LeagueConfig, split: Split, config_sha256: String, history_sha256: String) -> Result<Report> {
    let run_at = chrono::Utc::now().to_rfc3339();
    validate(history, cfg, split)?;
    let baseline = Parameters::from_settings(&cfg.bayesian);
    eprintln!(
        "Searching Bayesian parameters using seasons {}–{} only...",
        split.tune_start, split.tune_end
    );
    let mut prepared = prepare(history, cfg, split.tune_start, split.tune_end)?;
    let (coarse_grid, grid_source) = Grid::starting(cfg.tuning_grids.as_ref().and_then(|g| g.bayesian.as_ref()));
    let mut candidates = Vec::new();
    add_candidates(&mut candidates, vec![baseline], &mut prepared, cfg)?;
    add_candidates(&mut candidates, coarse_grid.candidates(), &mut prepared, cfg)?;
    let centers: Vec<_> = candidates.iter().take(3).map(|c| c.parameters).collect();
    for &center in &centers {
        add_candidates(&mut candidates, Grid::around(center).candidates(), &mut prepared, cfg)?;
    }
    let (selected, near_best_candidates) = select(&candidates, baseline);
    let evaluated_ranges = Ranges::of(&candidates.iter().map(|c| c.parameters).collect::<Vec<_>>());
    let selected_on_boundary = evaluated_ranges.boundary(selected.parameters);
    let baseline_tuning = &candidates.iter().find(|c| c.parameters == baseline).unwrap().evaluation;
    eprintln!(
        "Selected from {} candidates; evaluating held-out seasons {}–{}...",
        candidates.len(),
        split.tune_end + 1,
        split.test_end
    );
    let mut heldout = prepare(history, cfg, split.tune_end + 1, split.test_end)?;
    let baseline_holdout = evaluate(&mut heldout, cfg, baseline)?;
    let selected_holdout = if selected.parameters == baseline {
        baseline_holdout.clone()
    } else {
        evaluate(&mut heldout, cfg, selected.parameters)?
    };
    let boundary = boundary_note(&selected_on_boundary);
    Ok(Report {
        run_at,
        league: cfg.id.clone(),
        config_sha256,
        history_sha256,
        method: "Fixed Elo; preseason priors and tie weight use earlier seasons only; Laplace posterior and Simpson predictive integration; earlier UTC dates only; minimize equally weighted season log loss",
        selection_rule: "Within one paired-season standard error of minimum log loss, choose closest to current settings by sum of squared log parameter ratios; break ties by log loss",
        split,
        fixed_elo: cfg.elo.clone(),
        baseline_parameters: baseline,
        selected_parameters: selected.parameters,
        search: SearchReport {
            grid_source,
            coarse_grid,
            refinement_centers: centers,
            refinement_multipliers: [1.0 / std::f64::consts::SQRT_2, 1.0, std::f64::consts::SQRT_2],
            candidates_evaluated: candidates.len(),
            near_best_candidates,
            minimum_log_loss_parameters: candidates[0].parameters,
            top_candidates: candidates
                .iter()
                .take(10)
                .map(|c| CandidateSummary {
                    parameters: c.parameters,
                    mean_season_log_loss: c.evaluation.mean_season_log_loss,
                    mean_season_brier: c.evaluation.mean_season_brier,
                })
                .collect(),
            evaluated_ranges,
            selected_on_boundary,
        },
        tuning: compare(baseline_tuning.clone(), selected.evaluation.clone()),
        holdout: compare(baseline_holdout, selected_holdout),
        notes: [
            "Offline: configuration and history are read once; published seeds are unused; inputs are never changed.",
            "Tie weight is reestimated for each season from earlier history and remains fixed within that season. Postseason follows the configured tie rules.",
            "Rare ties can leave tie smoothing weakly identified. The conservative selection is a stability heuristic, not a significance test.",
            "The grid and one local refinement are bounded; the minimum is not a guarantee of a global optimum.",
            "Log loss uses natural logs and a 1e-15 probability floor; Brier score sums squared errors across all three outcomes.",
            "First/second halves divide chronologically ordered games by count. Calibration bins are per outcome; expected/observed tie totals are also reported.",
            "Positive baseline-minus-selected log loss indicates improvement; paired-season standard errors are descriptive and seasons may be dependent.",
            "Only the frozen selection and current settings are evaluated on the holdout. Earlier holdout outcomes can train later holdout predictions, but never change selected parameters.",
            "Holdout validity also requires that these seasons did not influence Elo settings or previous search choices. Repeated search changes after inspecting holdout scores invalidate it.",
        ]
        .into_iter()
        .map(String::from)
        .chain(boundary)
        .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_all_three_outcomes_and_weights_seasons_equally() {
        let rows = [PredictionRow {
            probabilities: Probabilities {
                home_win: 0.5,
                away_win: 0.3,
                tie: 0.2,
            },
            outcome: Outcome::Tie,
        }];
        let s = score(&rows).unwrap();
        assert!((s.log_loss + 0.2_f64.ln()).abs() < 1e-12);
        assert!((s.brier - 0.98).abs() < 1e-12);
        assert_eq!(s.expected_ties, 0.2);
        assert_eq!(s.observed_ties, 1);
        let (cfg, mut history) = crate::fixtures::fixture();
        history.games.retain(|g| g.season != 2004 || g.round != 2);
        let mut prepared = prepare(&history, &cfg, 2003, 2004).unwrap();
        let result = evaluate(&mut prepared, &cfg, Parameters::from_settings(&cfg.bayesian)).unwrap();
        assert_eq!(result.games, 7);
        let a = result.seasons[0].overall.log_loss;
        let b = result.seasons[1].overall.log_loss;
        assert_eq!(result.mean_season_log_loss, (a + b) / 2.0);
        assert!((result.pooled.log_loss - (4.0 * a + 3.0 * b) / 7.0).abs() < 1e-12);
        assert_eq!(
            result
                .calibration
                .iter()
                .filter(|b| b.outcome == Outcome::Tie)
                .map(|b| b.games)
                .sum::<usize>(),
            7
        );
    }

    #[test]
    fn same_utc_day_and_future_results_cannot_leak_into_predictions_or_preseason_tie_weight() {
        let (cfg, mut history) = crate::fixtures::fixture();
        let mut games = history.games.iter_mut().filter(|g| g.season == 2003);
        games.next().unwrap().start_time_utc = "2003-09-07T23:30:00-04:00".parse().unwrap();
        games.next().unwrap().start_time_utc = "2003-09-08T22:00:00Z".parse().unwrap();
        let mut prepared = prepare(&history, &cfg, 2003, 2003).unwrap();
        let before = predict_season(&mut prepared[0], &cfg).unwrap();
        let tie_weight = prepared[0].seed.tie_weight;
        prepared[0].games[0].result = Some(Outcome::AwayWin);
        prepared[0].games[1].result = Some(Outcome::HomeWin);
        let after = predict_season(&mut prepared[0], &cfg).unwrap();
        assert_eq!(prepared[0].seed.tie_weight, tie_weight);
        for i in 0..2 {
            assert_eq!(before[i].probabilities.home_win, after[i].probabilities.home_win);
            assert_eq!(before[i].probabilities.tie, after[i].probabilities.tie);
        }
        assert_ne!(before[2].probabilities.home_win, after[2].probabilities.home_win);
        assert_eq!(before[3].probabilities.tie, 0.0);
        for g in history.games.iter_mut().filter(|g| g.season >= 2003) {
            g.result = Some(Outcome::AwayWin);
        }
        let changed = prepare(&history, &cfg, 2003, 2003).unwrap();
        assert_eq!(changed[0].seed.tie_weight, tie_weight);
        assert_eq!(
            serde_json::to_value(&changed[0].seed.ratings).unwrap(),
            serde_json::to_value(&prepared[0].seed.ratings).unwrap()
        );
    }

    #[test]
    fn selection_keeps_defaults_in_a_flat_region_and_moves_for_consistent_improvement() {
        let (cfg, history) = crate::fixtures::fixture();
        let baseline = Parameters::from_settings(&cfg.bayesian);
        let mut prepared = prepare(&history, &cfg, 2003, 2004).unwrap();
        let mut best = evaluate(&mut prepared, &cfg, baseline).unwrap();
        for s in &mut best.seasons {
            s.overall.log_loss = 0.5;
        }
        best.mean_season_log_loss = 0.5;
        let mut near = best.clone();
        near.seasons[1].overall.log_loss = 0.6;
        near.mean_season_log_loss = 0.55;
        let mut candidates = vec![
            Candidate {
                parameters: Parameters {
                    prior_sd_elo: 100.0,
                    ..baseline
                },
                evaluation: best,
            },
            Candidate {
                parameters: baseline,
                evaluation: near,
            },
        ];
        assert_eq!(select(&candidates, baseline).0.parameters, baseline);
        for s in &mut candidates[1].evaluation.seasons {
            s.overall.log_loss = 0.55;
        }
        assert_eq!(select(&candidates, baseline).0.parameters.prior_sd_elo, 100.0);
        assert_eq!(Grid::coarse().candidates().len(), 120);
        assert!(Grid::coarse().candidates().contains(&baseline));
    }

    #[test]
    fn default_starting_grid_keeps_the_previous_constants_and_a_configured_grid_replaces_it() {
        let (grid, source) = Grid::starting(None);
        assert_eq!(source, "default");
        assert_eq!(grid.prior_sd_elo, [50.0, 75.0, 100.0, 150.0, 200.0, 300.0]);
        assert_eq!(grid.tie_prior_games, [10.0, 30.0, 100.0, 300.0, 1000.0]);
        assert_eq!(grid.tie_prior_rate, [0.001, 0.0025, 0.005, 0.01]);
        assert_eq!(grid.candidates().len(), 120);
        let configured = BayesianGrid {
            prior_sd_elo: vec![60.0, 120.0],
            tie_prior_games: vec![20.0, 40.0, 80.0],
            tie_prior_rate: vec![0.002, 0.004],
        };
        let (grid, source) = Grid::starting(Some(&configured));
        assert_eq!(source, "config");
        assert_eq!(grid.prior_sd_elo, configured.prior_sd_elo);
        assert_eq!(grid.tie_prior_games, configured.tie_prior_games);
        assert_eq!(grid.tie_prior_rate, configured.tie_prior_rate);
        assert_eq!(grid.candidates().len(), 12);
    }

    #[test]
    fn boundary_detection_flags_minimum_and_maximum_and_ignores_interior_values() {
        let p = |prior_sd_elo, tie_prior_games, tie_prior_rate| Parameters {
            prior_sd_elo,
            tie_prior_games,
            tie_prior_rate,
        };
        let ranges = Ranges::of(&[p(100.0, 30.0, 0.005), p(50.0, 100.0, 0.001), p(200.0, 10.0, 0.01)]);
        assert_eq!(
            ranges,
            Ranges {
                prior_sd_elo: [50.0, 200.0],
                tie_prior_games: [10.0, 100.0],
                tie_prior_rate: [0.001, 0.01],
            }
        );
        assert!(ranges.boundary(p(100.0, 30.0, 0.005)).is_empty());
        assert_eq!(ranges.boundary(p(50.0, 30.0, 0.01)), ["prior_sd_elo", "tie_prior_rate"]);
        assert_eq!(ranges.boundary(p(100.0, 10.0, 0.001)), ["tie_prior_games", "tie_prior_rate"]);
        assert_eq!(boundary_note(&[]), None);
        assert_eq!(
            boundary_note(&["tie_prior_games"]).unwrap(),
            "Selected parameters lie on a searched boundary (tie_prior_games); extend tuning_grids in the league configuration and rerun before adopting."
        );
    }
}
