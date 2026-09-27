use serde_json::{Value, json};
use std::{fs, process::Command};

#[test]
fn importer_warns_writes_utc_and_keeps_existing_history_on_missing_date() {
    let dir = tempfile::tempdir().unwrap();
    let config_path = dir.path().join("config.json");
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
            .arg("--config")
            .arg(&config_path)
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
