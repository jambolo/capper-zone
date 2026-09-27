use anyhow::{Context, Result, ensure};
use clap::Parser;
use rating_core::{GameFile, HISTORY_SCHEMA_VERSION, fetch_source, load_config, lock, parse_source_with_warnings, write_json};
use std::{fs, path::PathBuf};

#[derive(Parser)]
#[command(about = "Download and normalize completed historical seasons; never write current-season data")]
struct Args {
    #[arg(long, default_value = "config/nfl.json")]
    config: PathBuf,
    #[arg(long, default_value = "data")]
    data_dir: PathBuf,
    #[arg(long)]
    through_season: Option<i32>,
    /// Read an already-downloaded provider file instead of making a network request.
    #[arg(long)]
    input: Option<PathBuf>,
}
fn main() -> Result<()> {
    let args = Args::parse();
    let (cfg, _) = load_config(&args.config)?;
    let through = args.through_season.unwrap_or(cfg.current_season() - 1);
    ensure!(
        through >= cfg.history_start && through < cfg.current_season(),
        "Historical range must end before the current season"
    );
    let dir = args.data_dir.join(&cfg.id);
    let _lock = lock(&dir.join("history.lock"))?;
    let text = match args.input {
        Some(p) => fs::read_to_string(p).context("Read source file")?,
        None => fetch_source(&cfg.source.url)?,
    };
    let games = parse_source_with_warnings(&text, &cfg, |warning| eprintln!("Warning: {warning}"))?
        .into_iter()
        .filter(|g| g.season >= cfg.history_start && g.season <= through)
        .collect::<Vec<_>>();
    for year in cfg.history_start..=through {
        ensure!(
            games.iter().any(|g| g.season == year && g.result.is_some()),
            "Source missing completed season {year}; previous file has been kept"
        );
        if cfg.source.kind == "nflverse-csv" {
            ensure!(
                games
                    .iter()
                    .any(|g| g.season == year && g.round_label == "SB" && g.result.is_some()),
                "Season {year} has no completed Super Bowl; previous file has been kept"
            );
        }
    }
    let file = GameFile {
        schema_version: HISTORY_SCHEMA_VERSION,
        league: cfg.id.clone(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
        source_url: cfg.source.url,
        from_season: cfg.history_start,
        through_season: through,
        teams: cfg.teams.clone(),
        games,
    };
    let path = dir.join("history.json");
    write_json(&path, &file)?;
    println!(
        "Saved {} games, seasons {}–{}, to {}",
        file.games.len(),
        file.from_season,
        file.through_season,
        path.display()
    );
    Ok(())
}
