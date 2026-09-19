use anyhow::{Context, Result};
use clap::Parser;
use rating_core::{GameFile, build_seed, load_config, lock, write_json};
use std::{fs, path::PathBuf};

#[derive(Parser)]
#[command(about = "Calculate historical Elo and save independent preseason priors")]
struct Args {
    #[arg(long, default_value = "config/nfl.json")]
    config: PathBuf,
    #[arg(long, default_value = "data")]
    data_dir: PathBuf,
    #[arg(long)]
    target_season: Option<i32>,
}
fn main() -> Result<()> {
    let args = Args::parse();
    let (cfg, config_bytes) = load_config(&args.config)?;
    let season = args.target_season.unwrap_or(cfg.current_season());
    let dir = args.data_dir.join(&cfg.id);
    let _lock = lock(&dir.join("elo.lock"))?;
    let history_bytes = fs::read(dir.join("history.json")).context("Read history.json; run history-importer first")?;
    let history: GameFile = serde_json::from_slice(&history_bytes)?;
    let seed = build_seed(&history, &history_bytes, &cfg, &config_bytes, season)?;
    let path = dir.join(format!("elo-{season}.json"));
    write_json(&path, &seed)?;
    println!(
        "Saved {} team priors for {season} from {} completed games ({} ties) to {}",
        seed.ratings.len(),
        seed.completed_games,
        seed.tied_games,
        path.display()
    );
    Ok(())
}
