use anyhow::{Context, Result};
use clap::Parser;
use rating_core::{GameFile, digest, load_league_config, write_json};
use std::{fs, io::Write, path::PathBuf};

mod tuning;

#[derive(Parser)]
#[command(about = "Tune Elo K, home advantage, and offseason regression; report results")]
struct Args {
    /// League id; the configuration is read from `<config-dir>/<league>.json`.
    #[arg(long)]
    league: String,
    /// Directory containing `<league>.json` league configurations.
    #[arg(long, default_value = "config")]
    config_dir: PathBuf,
    #[arg(long, default_value = "data")]
    data_dir: PathBuf,
    /// Also save elo-tuning-report-<league>-<UTC date>.json in this directory.
    #[arg(long)]
    report_dir: Option<PathBuf>,
    /// First scored tuning season; defaults to config elo_tune.tune_start.
    #[arg(long)]
    tune_start: Option<i32>,
    /// Last scored tuning season; defaults to config elo_tune.tune_end.
    #[arg(long)]
    tune_end: Option<i32>,
    /// Final held-out season; defaults to config elo_tune.test_end.
    #[arg(long)]
    test_end: Option<i32>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let (cfg, config_bytes) = load_league_config(&args.config_dir, &args.league)?;
    let defaults = cfg.elo_tune.as_ref();
    let split = tuning::Split {
        warmup_start: cfg.history_start,
        tune_start: args
            .tune_start
            .or(defaults.map(|s| s.tune_start))
            .context("Set elo_tune.tune_start in the config or pass --tune-start")?,
        tune_end: args
            .tune_end
            .or(defaults.map(|s| s.tune_end))
            .context("Set elo_tune.tune_end in the config or pass --tune-end")?,
        test_end: args
            .test_end
            .or(defaults.map(|s| s.test_end))
            .context("Set elo_tune.test_end in the config or pass --test-end")?,
    };
    let history_bytes =
        fs::read(args.data_dir.join(&cfg.id).join("history.json")).context("Read history.json; run history-importer first")?;
    let history: GameFile = serde_json::from_slice(&history_bytes)
        .context("Parse history.json; start_time_utc, numeric round, and round_label are required; rerun history-importer")?;
    let report = tuning::run(&history, &cfg, split, digest(&config_bytes), digest(&history_bytes))?;
    if let Some(dir) = args.report_dir {
        let run_at = chrono::DateTime::parse_from_rfc3339(&report.run_at)?.with_timezone(&chrono::Utc);
        let path = dir.join(format!(
            "elo-tuning-report-{}-{}.json",
            report.league,
            run_at.format("%Y-%m-%d")
        ));
        write_json(&path, &report).with_context(|| format!("Write report {}", path.display()))?;
        eprintln!("Saved report to {}", path.display());
    }
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, &report)?;
    writeln!(stdout)?;
    Ok(())
}
