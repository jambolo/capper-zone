use rating_core::{EloTuneSettings, HISTORY_SCHEMA_VERSION, Outcome};
use serde_json::Value;
use std::{fs, path::Path, process::Command};

mod common;
use common::fixture;

fn invoke(root: &Path, extra: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_bayes-tune"))
        .current_dir(root)
        .args(["--config", "config.json", "--data-dir", "data"])
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
    fs::write(dir.path().join("config.json"), &config_bytes).unwrap();
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
    assert_eq!(fs::read(dir.path().join("config.json")).unwrap(), config_bytes);
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
        fs::write(dir.path().join("config.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
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
    fs::write(dir.path().join("config.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
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
    fs::write(dir.path().join("config.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
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
