use std::process::{Command, Output};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_elo-ratings")).args(args).output().unwrap()
}

#[test]
fn cli_requires_league() {
    let output = run(&[]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--league <LEAGUE>"));
}

#[test]
fn cli_rejects_unsafe_league_ids() {
    let output = run(&["--league", "NFL/../x"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Unsafe league id"));
}

#[test]
fn cli_reads_the_league_config_from_config_dir() {
    let config_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../config");
    let data_dir = concat!(env!("CARGO_TARGET_TMPDIR"), "/elo-ratings-cli-without-history");
    let output = run(&["--league", "nfl", "--config-dir", config_dir, "--data-dir", data_dir]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Read history.json; run history-importer first"), "{stderr}");
}
