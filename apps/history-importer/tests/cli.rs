use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn importer_warns_writes_utc_and_keeps_existing_history_on_missing_date() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("nfl.json");
    let source_path = dir.path().join("source.json");
    let mut cfg: Value = serde_json::from_str(include_str!("../../../config/nfl.json")).unwrap();
    cfg["source"]["kind"] = json!("canonical-json");
    fs::write(&config_path, cfg.to_string()).unwrap();
    let mut source = json!({"schema_version": 2, "league": "nfl", "games": [{
        "id": "missing-time", "league": "nfl", "season": 2002, "date": "2002-09-01", "time": null,
        "timezone": "America/New_York", "phase": "regular", "round_label": "REG", "round": 1,
        "home_team": "SEA", "away_team": "SF", "home_source_id": "SEA", "away_source_id": "SF",
        "neutral": true, "result": "home_win"
    }]});
    source["games"][0]["start_time_utc"] = json!("1900-01-01T00:00:00Z");
    let mut ambiguous = source["games"][0].clone();
    ambiguous["id"] = json!("ambiguous-time");
    ambiguous["date"] = json!("2002-10-27");
    ambiguous["time"] = json!("01:30");
    source["games"].as_array_mut().unwrap().push(ambiguous);
    fs::write(&source_path, source.to_string()).unwrap();
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_history-importer"))
            .args(["--league", "nfl", "--config-dir"])
            .arg(dir.path())
            .arg("--input")
            .arg(&source_path)
            .arg("--data-dir")
            .arg(dir.path())
            .args(["--through-season", "2002"])
            .output()
            .unwrap()
    };
    let output = run();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(output.status.success(), "{stderr}");
    assert!(stderr.contains("Warning: Game missing-time: missing time"));
    assert!(stderr.contains("Warning: Game ambiguous-time: ambiguous local time"));
    assert!(stderr.contains("earlier occurrence"));
    let history_path = dir.path().join("nfl/history.json");
    let saved = fs::read(&history_path).unwrap();
    let history: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(history["schema_version"], 3);
    for game in history["games"].as_array().unwrap() {
        assert_eq!(game["round"], 1);
        assert_eq!(game["round_label"], "REG");
        for field in ["date", "time", "timezone"] {
            assert!(game.get(field).is_none(), "Unexpected historical field: {field}");
        }
    }
    assert_eq!(history["games"][0]["start_time_utc"], "2002-09-01T04:00:00Z");
    assert_eq!(history["games"][1]["start_time_utc"], "2002-10-27T05:30:00Z");
    source["games"][0].as_object_mut().unwrap().remove("date");
    fs::write(&source_path, source.to_string()).unwrap();
    let output = run();
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Missing source date for game missing-time")
    );
    assert_eq!(fs::read(history_path).unwrap(), saved);
}

#[test]
fn importer_requires_a_completed_super_bowl_and_keeps_history_otherwise() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("nfl.json");
    let source_path = dir.path().join("games.csv");
    fs::write(&config_path, include_str!("../../../config/nfl.json")).unwrap();
    let header = "game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\n";
    let regular = "reg,2002,REG,1,2002-09-08,13:00,SF,10,SEA,20,Home\n";
    let super_bowl = "sb,2002,SB,21,2003-01-26,18:25,OAK,21,TB,48,Neutral\n";
    let run = |csv: String| {
        fs::write(&source_path, csv).unwrap();
        Command::new(env!("CARGO_BIN_EXE_history-importer"))
            .args(["--league", "nfl", "--config-dir"])
            .arg(dir.path())
            .arg("--input")
            .arg(&source_path)
            .arg("--data-dir")
            .arg(dir.path())
            .args(["--through-season", "2002"])
            .output()
            .unwrap()
    };
    let output = run(format!("{header}{regular}{super_bowl}"));
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let history_path = dir.path().join("nfl/history.json");
    let saved = fs::read(&history_path).unwrap();
    let history: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(history["games"].as_array().unwrap().len(), 2);
    let output = run(format!("{header}{regular}"));
    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Season 2002 has no completed Super Bowl; previous file has been kept")
    );
    assert_eq!(fs::read(history_path).unwrap(), saved);
}

#[test]
fn cli_requires_league() {
    let output = Command::new(env!("CARGO_BIN_EXE_history-importer")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--league <LEAGUE>"));
}

#[test]
fn importer_rejects_two_files_for_a_single_document_source() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("nfl.json"), include_str!("../../../config/nfl.json")).unwrap();
    let csv = "game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,location\n\
               reg,2002,REG,1,2002-09-08,13:00,SF,10,SEA,20,Home\n\
               sb,2002,SB,21,2003-01-26,18:25,OAK,21,TB,48,Neutral\n";
    let (first, second) = (dir.path().join("a.csv"), dir.path().join("b.csv"));
    fs::write(&first, csv).unwrap();
    fs::write(&second, csv).unwrap();
    for repeated_flag in [false, true] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_history-importer"));
        command
            .args(["--league", "nfl", "--config-dir"])
            .arg(dir.path())
            .arg("--data-dir")
            .arg(dir.path())
            .args(["--through-season", "2002", "--input"])
            .arg(&first);
        if repeated_flag {
            command.arg("--input");
        }
        let output = command.arg(&second).output().unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("The nflverse-csv adapter expects exactly one document, got 2"),
            "{stderr}"
        );
        assert!(!dir.path().join("nfl/history.json").exists());
    }
}

#[test]
fn importer_reads_one_file_per_season_and_requires_a_completed_world_series() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg: Value = serde_json::from_str(include_str!("../../../config/mlb.json")).unwrap();
    cfg["history_start"] = json!(2025);
    fs::write(dir.path().join("mlb.json"), cfg.to_string()).unwrap();
    let fixture: Value =
        serde_json::from_str(include_str!("../../../crates/rating-core/tests/fixtures/mlb-statsapi.json")).unwrap();
    let documents = fixture["documents"].as_array().unwrap().clone();
    let run = |documents: &[Value]| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_history-importer"));
        command
            .args(["--league", "mlb", "--config-dir"])
            .arg(dir.path())
            .arg("--data-dir")
            .arg(dir.path())
            .args(["--through-season", "2025", "--input"]);
        for (i, document) in documents.iter().enumerate() {
            let path = dir.path().join(format!("schedule-{i}.json"));
            fs::write(&path, document.to_string()).unwrap();
            command.arg(path);
        }
        command.output().unwrap()
    };
    let output = run(&documents);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("Saved 10 games, seasons 2025–2025"));
    let history_path = dir.path().join("mlb/history.json");
    let saved = fs::read(&history_path).unwrap();
    let history: Value = serde_json::from_slice(&saved).unwrap();
    let ids: Vec<&str> = history["games"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "778563", "778370", "900004", "900024", "776907", "776691", "813072", "813047", "813040", "813024"
        ]
    );
    let without_world_series: Vec<Value> = documents
        .iter()
        .map(|document| {
            let mut document = document.clone();
            for date in document["dates"].as_array_mut().unwrap() {
                date["games"].as_array_mut().unwrap().retain(|g| g["gameType"] != "W");
            }
            document
        })
        .collect();
    let output = run(&without_world_series);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Season 2025 has no completed World Series; previous file has been kept"),
        "{stderr}"
    );
    assert_eq!(fs::read(history_path).unwrap(), saved);
}
