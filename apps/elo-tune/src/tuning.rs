use anyhow::Result;
pub use rating_core::tuning::Split;
use rating_core::tuning::validate;
use rating_core::{Audit, EloGrid, EloSettings, GameFile, LeagueConfig, replay_elo};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Parameters {
    pub k: f64,
    pub home_advantage: f64,
    pub offseason_regression: f64,
}

impl Parameters {
    fn from_settings(settings: &EloSettings) -> Self {
        Self {
            k: settings.k,
            home_advantage: settings.home_advantage,
            offseason_regression: settings.offseason_regression,
        }
    }

    fn distance(self, baseline: Self) -> f64 {
        ((self.k - baseline.k) / baseline.k).powi(2)
            + ((self.home_advantage - baseline.home_advantage) / 25.0).powi(2)
            + ((self.offseason_regression - baseline.offseason_regression) / 0.25).powi(2)
    }
}

#[derive(Clone, Serialize)]
pub struct Score {
    pub games: usize,
    pub mse: f64,
}

#[derive(Clone, Serialize)]
pub struct SeasonScore {
    pub season: i32,
    pub overall: Score,
    pub first_half: Option<Score>,
    pub second_half: Option<Score>,
}

#[derive(Clone, Serialize)]
pub struct CalibrationBin {
    pub lower: f64,
    pub upper: f64,
    pub games: usize,
    pub mean_expected_score: f64,
    pub mean_observed_score: f64,
}

#[derive(Clone, Serialize)]
pub struct Evaluation {
    pub games: usize,
    pub mean_season_mse: f64,
    pub pooled_mse: f64,
    pub seasons: Vec<SeasonScore>,
    pub calibration: Vec<CalibrationBin>,
}

struct Candidate {
    parameters: Parameters,
    evaluation: Evaluation,
}

#[derive(Serialize)]
pub struct SeasonDifference {
    pub season: i32,
    pub baseline_minus_selected_mse: f64,
}

#[derive(Serialize)]
pub struct Comparison {
    pub baseline: Evaluation,
    pub selected: Evaluation,
    pub mean_season_mse_improvement: f64,
    pub relative_improvement_percent: Option<f64>,
    pub paired_season_standard_error: Option<f64>,
    pub season_differences: Vec<SeasonDifference>,
}

#[derive(Clone, Serialize)]
pub struct Grid {
    k: Vec<f64>,
    home_advantage: Vec<f64>,
    offseason_regression: Vec<f64>,
}

impl Grid {
    fn coarse() -> Self {
        Self {
            k: vec![10.0, 15.0, 20.0, 30.0, 40.0],
            home_advantage: vec![0.0, 25.0, 40.0, 55.0, 70.0],
            offseason_regression: vec![0.0, 0.15, 1.0 / 3.0, 0.5, 0.75],
        }
    }

    /// The league's configured starting grid if present, else the default coarse grid, with its source label.
    fn starting(configured: Option<&EloGrid>) -> (Self, &'static str) {
        match configured {
            Some(g) => (
                Self {
                    k: g.k.clone(),
                    home_advantage: g.home_advantage.clone(),
                    offseason_regression: g.offseason_regression.clone(),
                },
                "config",
            ),
            None => (Self::coarse(), "default"),
        }
    }

    fn candidates(&self) -> Vec<Parameters> {
        let mut result = Vec::new();
        for &k in &self.k {
            for &home_advantage in &self.home_advantage {
                for &offseason_regression in &self.offseason_regression {
                    result.push(Parameters {
                        k,
                        home_advantage,
                        offseason_regression,
                    });
                }
            }
        }
        result
    }

    fn expand(&mut self, best: Parameters) -> bool {
        let mut changed = false;
        if best.k == self.k[0] {
            self.k.insert(0, best.k / 2.0);
            changed = true;
        } else if best.k == *self.k.last().unwrap() {
            self.k.push(best.k * 2.0);
            changed = true;
        }
        if best.home_advantage == *self.home_advantage.last().unwrap() {
            self.home_advantage.push(best.home_advantage + 25.0);
            changed = true;
        }
        if best.offseason_regression == *self.offseason_regression.last().unwrap() && best.offseason_regression < 1.0 {
            self.offseason_regression.push(1.0);
            changed = true;
        }
        changed
    }
}

/// Inclusive `[min, max]` of each parameter over every evaluated candidate.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Ranges {
    pub k: [f64; 2],
    pub home_advantage: [f64; 2],
    pub offseason_regression: [f64; 2],
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
            k: range(|p| p.k),
            home_advantage: range(|p| p.home_advantage),
            offseason_regression: range(|p| p.offseason_regression),
        }
    }

    /// Parameter names, in report key order, whose selected value equals its evaluated minimum or maximum.
    fn boundary(&self, selected: Parameters) -> Vec<&'static str> {
        [
            ("k", selected.k, self.k),
            ("home_advantage", selected.home_advantage, self.home_advantage),
            (
                "offseason_regression",
                selected.offseason_regression,
                self.offseason_regression,
            ),
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
    pub parameters: Parameters,
    pub mean_season_mse: f64,
}

#[derive(Serialize)]
pub struct SearchReport {
    pub grid_source: &'static str,
    pub coarse_grid: Grid,
    pub expanded_grid: Grid,
    pub expansion_rounds: usize,
    pub refinement_steps: Parameters,
    pub candidates_evaluated: usize,
    pub near_best_candidates: usize,
    pub minimum_mse_parameters: Parameters,
    pub top_candidates: Vec<CandidateSummary>,
    pub evaluated_ranges: Ranges,
    pub selected_on_boundary: Vec<&'static str>,
}

#[derive(Serialize)]
pub struct Report {
    pub run_at: String,
    pub league: String,
    pub config_sha256: String,
    pub history_sha256: String,
    pub method: &'static str,
    pub selection_rule: &'static str,
    pub split: Split,
    pub initial_elo: f64,
    pub elo_scale: f64,
    pub baseline_parameters: Parameters,
    pub selected_parameters: Parameters,
    pub search: SearchReport,
    pub tuning: Comparison,
    pub holdout: Comparison,
    pub notes: Vec<String>,
}

fn score(rows: &[&Audit]) -> Option<Score> {
    (!rows.is_empty()).then(|| Score {
        games: rows.len(),
        mse: rows
            .iter()
            .map(|g| (g.expected_home_score - g.observed_home_score).powi(2))
            .sum::<f64>()
            / rows.len() as f64,
    })
}

fn evaluate(audit: &[Audit], start: i32, end: i32) -> Evaluation {
    let rows: Vec<_> = audit.iter().filter(|g| (start..=end).contains(&g.season)).collect();
    let mut by_season: BTreeMap<i32, Vec<&Audit>> = BTreeMap::new();
    let mut bins: [Vec<&Audit>; 10] = std::array::from_fn(|_| Vec::new());
    for &g in &rows {
        by_season.entry(g.season).or_default().push(g);
        bins[((g.expected_home_score * 10.0) as usize).min(9)].push(g);
    }
    let seasons: Vec<_> = by_season
        .into_iter()
        .map(|(season, games)| {
            let midpoint = games.len() / 2;
            SeasonScore {
                season,
                overall: score(&games).unwrap(),
                first_half: score(&games[..midpoint]),
                second_half: score(&games[midpoint..]),
            }
        })
        .collect();
    Evaluation {
        games: rows.len(),
        mean_season_mse: seasons.iter().map(|s| s.overall.mse).sum::<f64>() / seasons.len() as f64,
        pooled_mse: score(&rows).unwrap().mse,
        seasons,
        calibration: bins
            .iter()
            .enumerate()
            .filter(|(_, games)| !games.is_empty())
            .map(|(index, games)| CalibrationBin {
                lower: index as f64 / 10.0,
                upper: (index + 1) as f64 / 10.0,
                games: games.len(),
                mean_expected_score: games.iter().map(|g| g.expected_home_score).sum::<f64>() / games.len() as f64,
                mean_observed_score: games.iter().map(|g| g.observed_home_score).sum::<f64>() / games.len() as f64,
            })
            .collect(),
    }
}

fn evaluate_parameters(history: &GameFile, cfg: &LeagueConfig, parameters: Parameters, start: i32, end: i32) -> Result<Evaluation> {
    let mut candidate = cfg.clone();
    candidate.elo.k = parameters.k;
    candidate.elo.home_advantage = parameters.home_advantage;
    candidate.elo.offseason_regression = parameters.offseason_regression;
    let replay = replay_elo(&history.games, &candidate, end)?;
    Ok(evaluate(&replay.audit, start, end))
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
        .map(|(a, b)| a.overall.mse - b.overall.mse)
        .collect()
}

fn compare(baseline: Evaluation, selected: Evaluation) -> Comparison {
    let differences = differences(&baseline, &selected);
    let improvement = baseline.mean_season_mse - selected.mean_season_mse;
    Comparison {
        mean_season_mse_improvement: improvement,
        relative_improvement_percent: (baseline.mean_season_mse > 0.0).then(|| 100.0 * improvement / baseline.mean_season_mse),
        paired_season_standard_error: standard_error(&differences),
        season_differences: baseline
            .seasons
            .iter()
            .zip(differences)
            .map(|(s, difference)| SeasonDifference {
                season: s.season,
                baseline_minus_selected_mse: difference,
            })
            .collect(),
        baseline,
        selected,
    }
}

fn add_candidates(
    candidates: &mut Vec<Candidate>,
    parameters: impl IntoIterator<Item = Parameters>,
    history: &GameFile,
    cfg: &LeagueConfig,
    split: Split,
) -> Result<()> {
    for parameters in parameters {
        if !candidates.iter().any(|c| c.parameters == parameters) {
            candidates.push(Candidate {
                parameters,
                evaluation: evaluate_parameters(history, cfg, parameters, split.tune_start, split.tune_end)?,
            });
        }
    }
    candidates.sort_by(|a, b| a.evaluation.mean_season_mse.total_cmp(&b.evaluation.mean_season_mse));
    Ok(())
}

fn select(candidates: &[Candidate], baseline: Parameters) -> (&Candidate, usize) {
    let best = &candidates[0];
    // Paired season variation is a stability heuristic, not a significance test after searching.
    let eligible: Vec<_> = candidates
        .iter()
        .filter(|c| {
            c.evaluation.mean_season_mse - best.evaluation.mean_season_mse
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
                .then_with(|| a.evaluation.mean_season_mse.total_cmp(&b.evaluation.mean_season_mse))
        })
        .unwrap();
    (selected, eligible.len())
}

pub fn run(history: &GameFile, cfg: &LeagueConfig, split: Split, config_sha256: String, history_sha256: String) -> Result<Report> {
    let run_at = chrono::Utc::now().to_rfc3339();
    validate(history, cfg, split)?;
    let baseline = Parameters::from_settings(&cfg.elo);
    let (mut grid, grid_source) = Grid::starting(cfg.tuning_grids.as_ref().and_then(|g| g.elo.as_ref()));
    let coarse_grid = grid.clone();
    let mut candidates = Vec::new();
    eprintln!(
        "Searching Elo parameters using seasons {}–{} only...",
        split.tune_start, split.tune_end
    );
    add_candidates(&mut candidates, [baseline], history, cfg, split)?;
    add_candidates(&mut candidates, grid.candidates(), history, cfg, split)?;
    let mut expansion_rounds = 0;
    while expansion_rounds < 4 && grid.expand(candidates[0].parameters) {
        expansion_rounds += 1;
        add_candidates(&mut candidates, grid.candidates(), history, cfg, split)?;
    }
    let boundary_limited = grid.clone().expand(candidates[0].parameters);
    let steps = Parameters {
        k: 2.5,
        home_advantage: 5.0,
        offseason_regression: 0.05,
    };
    let centers: Vec<_> = candidates.iter().take(3).map(|c| c.parameters).collect();
    for center in centers {
        let local = Grid {
            k: (-2..=2)
                .map(|i| center.k + f64::from(i) * steps.k)
                .filter(|&k| k > 0.0)
                .collect(),
            home_advantage: (-2..=2)
                .map(|i| center.home_advantage + f64::from(i) * steps.home_advantage)
                .filter(|&h| h >= 0.0)
                .collect(),
            offseason_regression: (-2..=2)
                .map(|i| center.offseason_regression + f64::from(i) * steps.offseason_regression)
                .filter(|r| (0.0..=1.0).contains(r))
                .collect(),
        };
        add_candidates(&mut candidates, local.candidates(), history, cfg, split)?;
    }
    let (selected, near_best_candidates) = select(&candidates, baseline);
    let evaluated_ranges = Ranges::of(&candidates.iter().map(|c| c.parameters).collect::<Vec<_>>());
    let selected_on_boundary = evaluated_ranges.boundary(selected.parameters);
    let baseline_tuning = &candidates.iter().find(|c| c.parameters == baseline).unwrap().evaluation;
    eprintln!(
        "Selected parameters from {} candidates; evaluating held-out seasons {}–{}...",
        candidates.len(),
        split.tune_end + 1,
        split.test_end
    );
    // Only the frozen selection and existing settings ever reach the held-out evaluator.
    let baseline_holdout = evaluate_parameters(history, cfg, baseline, split.tune_end + 1, split.test_end)?;
    let selected_holdout = if selected.parameters == baseline {
        baseline_holdout.clone()
    } else {
        evaluate_parameters(history, cfg, selected.parameters, split.tune_end + 1, split.test_end)?
    };
    let mut notes = vec![
        "No Bayesian fitting or tie-probability estimation. Elo ties score 0.5; this MSE is not multiclass Brier score or log loss.".into(),
        "The initial rating and Elo scale remain fixed. Inputs are read once; there are no downloads or configuration/data writes.".into(),
        "First/second halves split each season's chronologically ordered games by count, including postseason games.".into(),
        "Calibration bins compare mean expected fractional score with mean observed fractional score, not win frequency.".into(),
        "Positive baseline-minus-selected MSE indicates improvement. Paired season standard errors are descriptive; few held-out seasons and dependent seasons limit inference.".into(),
        "Held-out results do not change the selection. Repeatedly revising the search after inspecting them would invalidate the holdout.".into(),
    ];
    if boundary_limited {
        notes.push("The coarse minimum still touched an expandable boundary after four expansions; the search is bounded, not a global optimum guarantee.".into());
    }
    notes.extend(boundary_note(&selected_on_boundary));
    Ok(Report {
        run_at,
        league: cfg.id.clone(),
        config_sha256,
        history_sha256,
        method: "Chronological Elo replay; score before updating; regress once per season boundary; minimize equally weighted season mean squared errors",
        selection_rule: "Among candidates within one paired-season standard error of the minimum MSE, choose closest to current settings by squared distance scaled by current K, 25 home Elo, and 0.25 regression; break ties by MSE",
        split,
        initial_elo: cfg.elo.initial,
        elo_scale: cfg.elo.scale,
        baseline_parameters: baseline,
        selected_parameters: selected.parameters,
        search: SearchReport {
            grid_source,
            coarse_grid,
            expanded_grid: grid,
            expansion_rounds,
            refinement_steps: steps,
            candidates_evaluated: candidates.len(),
            near_best_candidates,
            minimum_mse_parameters: candidates[0].parameters,
            top_candidates: candidates
                .iter()
                .take(10)
                .map(|c| CandidateSummary {
                    parameters: c.parameters,
                    mean_season_mse: c.evaluation.mean_season_mse,
                })
                .collect(),
            evaluated_ranges,
            selected_on_boundary,
        },
        tuning: compare(baseline_tuning.clone(), selected.evaluation.clone()),
        holdout: compare(baseline_holdout, selected_holdout),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(season: i32, expected: f64, observed: f64) -> Audit {
        Audit {
            game_id: String::new(),
            season,
            home_before: 1500.0,
            away_before: 1500.0,
            expected_home_score: expected,
            observed_home_score: observed,
            home_after: 1500.0,
            away_after: 1500.0,
        }
    }

    #[test]
    fn mse_uses_fractional_ties_excludes_warmup_and_weights_seasons_equally() {
        let audit = [
            row(2009, 0.0, 1.0),
            row(2010, 0.5, 0.5),
            row(2011, 0.0, 1.0),
            row(2011, 0.0, 1.0),
        ];
        let report = evaluate(&audit, 2010, 2011);
        assert_eq!(report.games, 3);
        assert_eq!(report.mean_season_mse, 0.5);
        assert!((report.pooled_mse - 2.0 / 3.0).abs() < 1e-12);
        assert_eq!(report.seasons[0].overall.mse, 0.0);
        assert!(report.seasons[0].first_half.is_none());
        assert_eq!(report.seasons[1].first_half.as_ref().unwrap().mse, 1.0);
        assert_eq!(report.calibration[1].mean_observed_score, 0.5);
        assert_eq!(report.calibration[0].games, 2);
    }

    #[test]
    fn selection_prefers_defaults_on_a_flat_region_but_not_for_consistently_worse_scores() {
        let baseline = Parameters {
            k: 20.0,
            home_advantage: 55.0,
            offseason_regression: 1.0 / 3.0,
        };
        let mut candidates = vec![
            Candidate {
                parameters: Parameters { k: 30.0, ..baseline },
                evaluation: evaluate(&[row(2010, 0.0, 0.0), row(2011, 0.0, 0.0)], 2010, 2011),
            },
            Candidate {
                parameters: baseline,
                evaluation: evaluate(&[row(2010, 0.0, 0.0), row(2011, 0.1, 0.0)], 2010, 2011),
            },
        ];
        let (selected, eligible) = select(&candidates, baseline);
        assert_eq!(selected.parameters, baseline);
        assert_eq!(eligible, 2);
        candidates[1].evaluation = evaluate(&[row(2010, 0.1, 0.0), row(2011, 0.1, 0.0)], 2010, 2011);
        assert_eq!(select(&candidates, baseline).0.parameters.k, 30.0);
        assert_eq!(standard_error(&[1.0, 3.0]), Some(1.0));
        assert_eq!(standard_error(&[1.0]), None);
    }

    #[test]
    fn coarse_grid_and_boundary_expansion_cover_the_proposed_search() {
        let mut grid = Grid::coarse();
        assert_eq!(grid.candidates().len(), 125);
        assert!(grid.expand(Parameters {
            k: 10.0,
            home_advantage: 70.0,
            offseason_regression: 0.75,
        }));
        assert_eq!(grid.k[0], 5.0);
        assert_eq!(*grid.home_advantage.last().unwrap(), 95.0);
        assert_eq!(*grid.offseason_regression.last().unwrap(), 1.0);
    }

    #[test]
    fn default_starting_grid_keeps_the_previous_constants_and_a_configured_grid_replaces_it() {
        let (grid, source) = Grid::starting(None);
        assert_eq!(source, "default");
        assert_eq!(grid.k, [10.0, 15.0, 20.0, 30.0, 40.0]);
        assert_eq!(grid.home_advantage, [0.0, 25.0, 40.0, 55.0, 70.0]);
        assert_eq!(grid.offseason_regression, [0.0, 0.15, 1.0 / 3.0, 0.5, 0.75]);
        assert_eq!(grid.candidates().len(), 125);
        let configured = EloGrid {
            k: vec![2.0, 4.0, 8.0],
            home_advantage: vec![12.0, 24.0],
            offseason_regression: vec![0.25, 0.5],
        };
        let (grid, source) = Grid::starting(Some(&configured));
        assert_eq!(source, "config");
        assert_eq!(grid.k, configured.k);
        assert_eq!(grid.home_advantage, configured.home_advantage);
        assert_eq!(grid.offseason_regression, configured.offseason_regression);
        assert_eq!(grid.candidates().len(), 12);
    }

    #[test]
    fn boundary_detection_flags_minimum_and_maximum_and_ignores_interior_values() {
        let p = |k, home_advantage, offseason_regression| Parameters {
            k,
            home_advantage,
            offseason_regression,
        };
        let ranges = Ranges::of(&[p(10.0, 40.0, 0.5), p(20.0, 0.0, 0.25), p(5.0, 70.0, 1.0)]);
        assert_eq!(
            ranges,
            Ranges {
                k: [5.0, 20.0],
                home_advantage: [0.0, 70.0],
                offseason_regression: [0.25, 1.0],
            }
        );
        assert!(ranges.boundary(p(10.0, 40.0, 0.5)).is_empty());
        assert_eq!(ranges.boundary(p(5.0, 40.0, 1.0)), ["k", "offseason_regression"]);
        assert_eq!(ranges.boundary(p(20.0, 0.0, 0.5)), ["k", "home_advantage"]);
        assert_eq!(boundary_note(&[]), None);
        assert_eq!(
            boundary_note(&["k", "offseason_regression"]).unwrap(),
            "Selected parameters lie on a searched boundary (k, offseason_regression); extend tuning_grids in the league configuration and rerun before adopting."
        );
    }
}
