use rating_core::{EloTuneSettings, Game, GameFile, HISTORY_SCHEMA_VERSION, LeagueConfig, Outcome};
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
            (1..=4).map(move |week| Game {
                id: format!("{season}-{week}"),
                league: "nfl".into(),
                season,
                kickoff_utc: format!("{season}-09-{:02}T17:00:00Z", week * 7).parse().unwrap(),
                phase: "regular".into(),
                round: "REG".into(),
                week,
                home_team: "ARI".into(),
                away_team: "ATL".into(),
                home_source_id: "ARI".into(),
                away_source_id: "ATL".into(),
                neutral: week == 4,
                result: Some(if week == 3 { Outcome::AwayWin } else { Outcome::HomeWin }),
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
    assert_eq!(fs::read(dir.path().join("config.json")).unwrap(), config_bytes);
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
    fs::write(dir.path().join("config.json"), serde_json::to_vec(&other_bayesian).unwrap()).unwrap();
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
    obsolete["schema_version"] = serde_json::json!(1);
    fs::write(&history_path, serde_json::to_vec(&obsolete).unwrap()).unwrap();
    let output = invoke(dir.path(), &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("rerun history-importer"));
    obsolete["schema_version"] = serde_json::json!(HISTORY_SCHEMA_VERSION);
    obsolete["games"][0].as_object_mut().unwrap().remove("kickoff_utc");
    fs::write(&history_path, serde_json::to_vec(&obsolete).unwrap()).unwrap();
    let output = invoke(dir.path(), &[]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("kickoff_utc") && error.contains("rerun history-importer"));
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
