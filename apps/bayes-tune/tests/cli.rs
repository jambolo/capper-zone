use rating_core::{BayesianGrid, EloGrid, EloTuneSettings, HISTORY_SCHEMA_VERSION, LeagueConfig, Outcome, TuningGrids};
use serde_json::Value;
use std::{fs, path::Path, process::Command};

mod common;
use common::fixture;

fn invoke(root: &Path, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_bayes-tune"))
        .current_dir(root)
        .args(["--league", "nfl", "--config-dir", ".", "--data-dir", "data"])
        .args(extra)
        .output()
        .unwrap()
}

#[test]
fn cli_is_read_only_repeatable_and_selects_independently_of_heldout_outcomes() {
    let dir = tempfile::tempdir().unwrap();
    let (cfg, mut history) = fixture();
    let config_bytes = serde_json::to_vec(&cfg).unwrap();
    let history_bytes = serde_json::to_vec(&history).unwrap();
    fs::create_dir_all(dir.path().join("data/nfl")).unwrap();
    fs::write(dir.path().join("nfl.json"), &config_bytes).unwrap();
    fs::write(dir.path().join("data/nfl/history.json"), &history_bytes).unwrap();
    fs::write(dir.path().join("data/nfl/elo-2006.json"), "untouched seed").unwrap();
    let started = chrono::Utc::now();
    let output = invoke(dir.path(), &["--report-dir", "reports"]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["split"],
        serde_json::json!({"warmup_start": 2002, "tune_start": 2003, "tune_end": 2004, "test_end": 2005})
    );
    let run_at = chrono::DateTime::parse_from_rfc3339(report["run_at"].as_str().unwrap()).unwrap();
    assert_eq!(run_at.offset().local_minus_utc(), 0);
    assert!(run_at >= started && run_at <= chrono::Utc::now());
    let report_path = dir
        .path()
        .join("reports")
        .join(format!("bayes-tuning-report-nfl-{}.json", run_at.format("%Y-%m-%d")));
    let saved: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(saved, report);
    assert_eq!(report["tuning"]["baseline"]["games"], 8);
    assert_eq!(report["holdout"]["baseline"]["games"], 4);
    assert_eq!(report["fixed_elo"], serde_json::to_value(&cfg.elo).unwrap());
    assert_eq!(report["config_sha256"], rating_core::digest(&config_bytes));
    assert_eq!(report["history_sha256"], rating_core::digest(&history_bytes));
    assert_eq!(report["baseline_parameters"]["prior_sd_elo"], cfg.bayesian.prior_sd_elo);
    assert!(report["search"]["candidates_evaluated"].as_u64().unwrap() >= 120);
    let again = invoke(dir.path(), &["--report-dir", "reports"]);
    assert!(again.status.success());
    let mut repeated: Value = serde_json::from_slice(&again.stdout).unwrap();
    let repeated_at = chrono::DateTime::parse_from_rfc3339(repeated["run_at"].as_str().unwrap()).unwrap();
    assert!(repeated_at >= run_at && repeated_at <= chrono::Utc::now());
    let repeated_path = dir
        .path()
        .join("reports")
        .join(format!("bayes-tuning-report-nfl-{}.json", repeated_at.format("%Y-%m-%d")));
    let saved: Value = serde_json::from_slice(&fs::read(repeated_path).unwrap()).unwrap();
    assert_eq!(saved, repeated);
    let mut original = report.clone();
    original.as_object_mut().unwrap().remove("run_at");
    repeated.as_object_mut().unwrap().remove("run_at");
    assert_eq!(original, repeated);
    assert_eq!(fs::read(dir.path().join("nfl.json")).unwrap(), config_bytes);
    assert_eq!(fs::read(dir.path().join("data/nfl/history.json")).unwrap(), history_bytes);
    assert_eq!(
        fs::read_to_string(dir.path().join("data/nfl/elo-2006.json")).unwrap(),
        "untouched seed"
    );
    assert_eq!(fs::read_dir(dir.path().join("data/nfl")).unwrap().count(), 2);

    for g in history.games.iter_mut().filter(|g| g.season == 2005) {
        g.result = Some(Outcome::AwayWin);
    }
    fs::write(
        dir.path().join("data/nfl/history.json"),
        serde_json::to_vec(&history).unwrap(),
    )
    .unwrap();
    let changed = invoke(dir.path(), &["--test-end", "2005"]);
    assert!(changed.status.success());
    let changed: Value = serde_json::from_slice(&changed.stdout).unwrap();
    assert_eq!(report["selected_parameters"], changed["selected_parameters"]);
    assert_eq!(report["search"], changed["search"]);
    assert_eq!(report["tuning"], changed["tuning"]);
    assert_ne!(report["holdout"], changed["holdout"]);
}

#[test]
fn cli_boundaries_override_config_and_work_without_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let (mut cfg, history) = fixture();
    fs::create_dir_all(dir.path().join("data/nfl")).unwrap();
    fs::write(
        dir.path().join("data/nfl/history.json"),
        serde_json::to_vec(&history).unwrap(),
    )
    .unwrap();
    for defaults in [
        Some(EloTuneSettings {
            tune_start: 2010,
            tune_end: 2022,
            test_end: 2025,
        }),
        None,
    ] {
        cfg.elo_tune = defaults;
        fs::write(dir.path().join("nfl.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
        if cfg.elo_tune.is_none() {
            let missing = invoke(dir.path(), &[]);
            assert!(!missing.status.success());
            assert!(String::from_utf8_lossy(&missing.stderr).contains("elo_tune.tune_start"));
        }
        let output = invoke(
            dir.path(),
            &["--tune-start", "2003", "--tune-end", "2004", "--test-end", "2005"],
        );
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            report["split"],
            serde_json::json!({"warmup_start": 2002, "tune_start": 2003, "tune_end": 2004, "test_end": 2005})
        );
    }
    cfg.elo_tune = Some(EloTuneSettings {
        tune_start: 2010,
        tune_end: 2022,
        test_end: 2025,
    });
    cfg.bayes_tune = Some(EloTuneSettings {
        tune_start: 2003,
        tune_end: 2004,
        test_end: 2005,
    });
    fs::write(dir.path().join("nfl.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
    let output = invoke(dir.path(), &[]);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["split"]["tune_start"], 2003);
}

#[test]
fn cli_rejects_invalid_splits_missing_seasons_and_unfinished_history() {
    let dir = tempfile::tempdir().unwrap();
    let (cfg, history) = fixture();
    fs::create_dir_all(dir.path().join("data/nfl")).unwrap();
    fs::write(dir.path().join("nfl.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
    let history_path = dir.path().join("data/nfl/history.json");
    fs::write(&history_path, serde_json::to_vec(&history).unwrap()).unwrap();
    let mut obsolete = serde_json::to_value(&history).unwrap();
    for version in [1, 2] {
        obsolete["schema_version"] = serde_json::json!(version);
        fs::write(&history_path, serde_json::to_vec(&obsolete).unwrap()).unwrap();
        let output = invoke(dir.path(), &[]);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("rerun history-importer"));
    }
    obsolete["schema_version"] = serde_json::json!(HISTORY_SCHEMA_VERSION);
    obsolete["games"][0].as_object_mut().unwrap().remove("start_time_utc");
    fs::write(&history_path, serde_json::to_vec(&obsolete).unwrap()).unwrap();
    let output = invoke(dir.path(), &[]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("start_time_utc") && error.contains("rerun history-importer"));
    fs::write(&history_path, serde_json::to_vec(&history).unwrap()).unwrap();
    let invalid = invoke(dir.path(), &["--test-end", "2004"]);
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("held-out seasons"));
    let short = invoke(dir.path(), &["--test-end", "2006"]);
    assert!(!short.status.success());
    assert!(String::from_utf8_lossy(&short.stderr).contains("History must cover"));
    let mut missing = history.clone();
    missing.games.retain(|g| g.season != 2003);
    fs::write(&history_path, serde_json::to_vec(&missing).unwrap()).unwrap();
    let missing = invoke(dir.path(), &["--test-end", "2005"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("Missing completed historical season 2003"));
    let mut unfinished = history;
    unfinished.games[0].result = None;
    fs::write(&history_path, serde_json::to_vec(&unfinished).unwrap()).unwrap();
    let unfinished = invoke(dir.path(), &["--test-end", "2005"]);
    assert!(!unfinished.status.success());
    assert!(String::from_utf8_lossy(&unfinished.stderr).contains("unreported game"));
}

#[test]
fn cli_requires_league() {
    let output = Command::new(env!("CARGO_BIN_EXE_bayes-tune")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--league <LEAGUE>"));
}

/// `evaluated_ranges` covers the baseline and the starting grid, and `selected_on_boundary` lists exactly
/// the parameters (in key order) whose selected value equals an evaluated extreme; the note appears iff any do.
fn assert_boundary_report(report: &Value) {
    let search = &report["search"];
    let mut on_boundary = Vec::new();
    for name in ["prior_sd_elo", "tie_prior_games", "tie_prior_rate"] {
        let range = &search["evaluated_ranges"][name];
        let (lo, hi) = (range[0].as_f64().unwrap(), range[1].as_f64().unwrap());
        let selected = report["selected_parameters"][name].as_f64().unwrap();
        let baseline = report["baseline_parameters"][name].as_f64().unwrap();
        let grid = search["coarse_grid"][name]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap());
        for value in grid.chain([selected, baseline]) {
            assert!(lo <= value && value <= hi, "{name}: {value} outside [{lo}, {hi}]");
        }
        if selected == lo || selected == hi {
            on_boundary.push(name);
        }
    }
    assert_eq!(search["selected_on_boundary"], serde_json::json!(on_boundary));
    let noted = report["notes"].as_array().unwrap().iter().any(|n| {
        n.as_str()
            .unwrap()
            .starts_with("Selected parameters lie on a searched boundary (")
    });
    assert_eq!(noted, !on_boundary.is_empty());
}

#[test]
fn cli_reports_grid_source_evaluated_ranges_and_boundary_flags() {
    let dir = tempfile::tempdir().unwrap();
    let (mut cfg, history) = fixture();
    fs::create_dir_all(dir.path().join("data/nfl")).unwrap();
    fs::write(
        dir.path().join("data/nfl/history.json"),
        serde_json::to_vec(&history).unwrap(),
    )
    .unwrap();
    let run = |cfg: &LeagueConfig| -> Value {
        fs::write(dir.path().join("nfl.json"), serde_json::to_vec(cfg).unwrap()).unwrap();
        let output = invoke(dir.path(), &[]);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    };
    cfg.tuning_grids = Some(TuningGrids {
        elo: Some(EloGrid {
            k: vec![15.0, 25.0],
            home_advantage: vec![30.0, 50.0],
            offseason_regression: vec![0.2, 0.4],
        }),
        bayesian: None,
    });
    let elo_only = run(&cfg);
    assert_eq!(elo_only["search"]["grid_source"], "default");
    assert_eq!(
        elo_only["search"]["coarse_grid"],
        serde_json::json!({
            "prior_sd_elo": [50.0, 75.0, 100.0, 150.0, 200.0, 300.0],
            "tie_prior_games": [10.0, 30.0, 100.0, 300.0, 1000.0],
            "tie_prior_rate": [0.001, 0.0025, 0.005, 0.01]
        })
    );
    assert!(elo_only["search"]["candidates_evaluated"].as_u64().unwrap() >= 120);
    assert_boundary_report(&elo_only);

    let grid = BayesianGrid {
        prior_sd_elo: vec![100.0, 200.0],
        tie_prior_games: vec![50.0, 150.0],
        tie_prior_rate: vec![0.004, 0.006],
    };
    cfg.tuning_grids = Some(TuningGrids {
        elo: None,
        bayesian: Some(grid.clone()),
    });
    let configured = run(&cfg);
    assert_eq!(configured["search"]["grid_source"], "config");
    assert_eq!(configured["search"]["coarse_grid"], serde_json::to_value(&grid).unwrap());
    assert_boundary_report(&configured);
}
