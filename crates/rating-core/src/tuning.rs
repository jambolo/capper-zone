use crate::{GameFile, HISTORY_SCHEMA_VERSION, LeagueConfig, adapter_for, validate_games};
use anyhow::{Result, bail, ensure};
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
pub struct Split {
    pub warmup_start: i32,
    pub tune_start: i32,
    pub tune_end: i32,
    pub test_end: i32,
}

pub fn validate(history: &GameFile, cfg: &LeagueConfig, split: Split) -> Result<()> {
    cfg.validate()?;
    ensure!(
        split.warmup_start == cfg.history_start
            && split.warmup_start < split.tune_start
            && split.tune_start < split.tune_end
            && split.tune_end < split.test_end
            && split.test_end < cfg.current_season(),
        "Require warm-up history, at least two tuning seasons, and later completed held-out seasons"
    );
    ensure!(
        history.schema_version == HISTORY_SCHEMA_VERSION && history.league == cfg.id && history.teams == cfg.teams,
        "History schema, league, or franchise identities do not match configuration; rerun history-importer"
    );
    ensure!(
        history.from_season == cfg.history_start && history.through_season >= split.test_end,
        "History must cover {} through {}; rerun history-importer with --through-season {}",
        cfg.history_start,
        split.test_end,
        split.test_end
    );
    ensure!(
        history
            .games
            .iter()
            .all(|g| (history.from_season..=history.through_season).contains(&g.season)),
        "Game is outside the history file's declared seasons"
    );
    let mut games = history.games.clone();
    validate_games(&mut games, cfg)?;
    ensure!(
        games
            .iter()
            .filter(|g| g.season <= split.test_end)
            .all(|g| g.result.is_some()),
        "Evaluation history contains an unreported game; use completed historical seasons"
    );
    let adapter = adapter_for(&cfg.source.kind)?;
    for season in cfg.history_start..=split.test_end {
        ensure!(
            games.iter().any(|g| g.season == season),
            "Missing completed historical season {season}"
        );
        if let Some(reason) = adapter.season_incomplete(&games, season) {
            bail!("Season {season} has {reason}; refresh history before tuning");
        }
    }
    Ok(())
}
