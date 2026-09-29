use rating_core::{
    BayesianGrid, EloGrid, EloTuneSettings, Game, GameFile, HISTORY_SCHEMA_VERSION, LeagueConfig, Outcome, TuningGrids,
};
use serde_json::Value;
use std::{fs, path::Path, process::Command};

fn fixture() -> (LeagueConfig, GameFile) {
    let mut cfg: LeagueConfig = serde_json::from_str(include_str!("../../../config/nfl.json")).unwrap();
    cfg.source.kind = "canonical-json".into();
    cfg.source.url = "https://invalid.example.test/no-network-needed".into();
    cfg.elo_tune = Some(EloTuneSettings {
        tune_start: 2003,
        tune_end: 2004,
        test_end: 2005,
    });
    let games = (2002..=2005)
        .flat_map(|season| {
            (1..=4).map(move |round| Game {
                id: format!("{season}-{round}"),
                league: "nfl".into(),
                season,
                start_time_utc: format!("{season}-09-{:02}T17:00:00Z", round * 7).parse().unwrap(),
                phase: "regular".into(),
                round_label: "REG".into(),
                round,
                home_team: "ARI".into(),
                away_team: "ATL".into(),
                home_source_id: "ARI".into(),
                away_source_id: "ATL".into(),
                neutral: round == 4,
                result: Some(if round == 3 { Outcome::AwayWin } else { Outcome::HomeWin }),
            })
        })
        .collect();
    let history = GameFile {
        schema_version: HISTORY_SCHEMA_VERSION,
        league: "nfl".into(),
        fetched_at: "2006-03-01T00:00:00Z".into(),
        source_url: cfg.source.url.clone(),
        from_season: 2002,
        through_season: 2005,
        teams: cfg.teams.clone(),
        games,
    };
    (cfg, history)
}

fn invoke(root: &Path, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_elo-tune"))
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
        .join(format!("elo-tuning-report-nfl-{}.json", run_at.format("%Y-%m-%d")));
    let saved: Value = serde_json::from_slice(&fs::read(&report_path).unwrap()).unwrap();
    assert_eq!(saved, report);
    assert_eq!(report["tuning"]["baseline"]["games"], 8);
    assert_eq!(report["holdout"]["baseline"]["games"], 4);
    assert_eq!(report["baseline_parameters"]["k"], cfg.elo.k);
    assert!(report["search"]["candidates_evaluated"].as_u64().unwrap() >= 125);
    let again = invoke(dir.path(), &["--report-dir", "reports"]);
    assert!(again.status.success());
    let mut repeated: Value = serde_json::from_slice(&again.stdout).unwrap();
    let repeated_at = chrono::DateTime::parse_from_rfc3339(repeated["run_at"].as_str().unwrap()).unwrap();
    assert!(repeated_at >= run_at && repeated_at <= chrono::Utc::now());
    let repeated_path = dir
        .path()
        .join("reports")
        .join(format!("elo-tuning-report-nfl-{}.json", repeated_at.format("%Y-%m-%d")));
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
        g.result = Some(Outcome::Tie);
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

    let mut other_bayesian = cfg;
    other_bayesian.bayesian.prior_sd_elo = 500.0;
    other_bayesian.bayesian.tie_prior_games = 1.0;
    other_bayesian.bayesian.tie_prior_rate = 0.25;
    fs::write(dir.path().join("nfl.json"), serde_json::to_vec(&other_bayesian).unwrap()).unwrap();
    let independent = invoke(dir.path(), &["--test-end", "2005"]);
    assert!(independent.status.success());
    let independent: Value = serde_json::from_slice(&independent.stdout).unwrap();
    assert_eq!(changed["search"], independent["search"]);
    assert_eq!(changed["selected_parameters"], independent["selected_parameters"]);
    assert_eq!(changed["tuning"], independent["tuning"]);
    assert_eq!(changed["holdout"], independent["holdout"]);
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
    let output = Command::new(env!("CARGO_BIN_EXE_elo-tune")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--league <LEAGUE>"));
}

/// `evaluated_ranges` covers the baseline and the starting grid, and `selected_on_boundary` lists exactly
/// the parameters (in key order) whose selected value equals an evaluated extreme; the note appears iff any do.
fn assert_boundary_report(report: &Value) {
    let search = &report["search"];
    let mut on_boundary = Vec::new();
    for name in ["k", "home_advantage", "offseason_regression"] {
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
    let default = run(&cfg);
    assert_eq!(default["search"]["grid_source"], "default");
    assert_eq!(
        default["search"]["coarse_grid"],
        serde_json::json!({
            "k": [10.0, 15.0, 20.0, 30.0, 40.0],
            "home_advantage": [0.0, 25.0, 40.0, 55.0, 70.0],
            "offseason_regression": [0.0, 0.15, 1.0 / 3.0, 0.5, 0.75]
        })
    );
    assert_boundary_report(&default);

    cfg.tuning_grids = Some(TuningGrids {
        elo: None,
        bayesian: Some(BayesianGrid {
            prior_sd_elo: vec![60.0],
            tie_prior_games: vec![20.0],
            tie_prior_rate: vec![0.002],
        }),
    });
    let bayesian_only = run(&cfg);
    assert_eq!(bayesian_only["search"], default["search"]);
    assert_eq!(bayesian_only["selected_parameters"], default["selected_parameters"]);

    let grid = EloGrid {
        k: vec![15.0, 25.0],
        home_advantage: vec![30.0, 50.0],
        offseason_regression: vec![0.2, 0.4],
    };
    cfg.tuning_grids = Some(TuningGrids {
        elo: Some(grid.clone()),
        bayesian: None,
    });
    let configured = run(&cfg);
    assert_eq!(configured["search"]["grid_source"], "config");
    assert_eq!(configured["search"]["coarse_grid"], serde_json::to_value(&grid).unwrap());
    assert_boundary_report(&configured);
}
