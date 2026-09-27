use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
    time::Duration,
};

mod elo;
mod time;
pub use elo::{EloReplay, expected_home, regress_rating, replay_elo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Source {
    pub kind: String,
    pub url: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TeamEra {
    pub from_season: i32,
    pub through_season: Option<i32>,
    pub name: String,
    /// Franchise market/region; individual stadium moves are venue metadata.
    pub location: String,
    pub source_ids: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub location: String,
    pub eras: Vec<TeamEra>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloSettings {
    pub initial: f64,
    pub scale: f64,
    pub k: f64,
    pub home_advantage: f64,
    pub offseason_regression: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BayesianSettings {
    pub prior_sd_elo: f64,
    pub tie_prior_games: f64,
    pub tie_prior_rate: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EloTuneSettings {
    pub tune_start: i32,
    pub tune_end: i32,
    pub test_end: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeagueConfig {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub history_start: i32,
    pub season_rollover_month: u32,
    pub source: Source,
    pub teams: Vec<Team>,
    pub aliases: BTreeMap<String, String>,
    pub ties_allowed_in: Vec<String>,
    pub elo: EloSettings,
    pub bayesian: BayesianSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elo_tune: Option<EloTuneSettings>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    HomeWin,
    AwayWin,
    Tie,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Game {
    pub id: String,
    pub league: String,
    pub season: i32,
    /// Authoritative kickoff instant, converted by the source adapter before storage.
    pub kickoff_utc: DateTime<Utc>,
    pub phase: String,
    pub round: String,
    pub week: u32,
    pub home_team: String,
    pub away_team: String,
    pub home_source_id: String,
    pub away_source_id: String,
    pub neutral: bool,
    pub result: Option<Outcome>,
}
pub const HISTORY_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameFile {
    pub schema_version: u32,
    pub league: String,
    pub fetched_at: String,
    pub source_url: String,
    pub from_season: i32,
    pub through_season: i32,
    pub teams: Vec<Team>,
    pub games: Vec<Game>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Rating {
    pub team: String,
    pub elo: f64,
    pub games: usize,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Audit {
    pub game_id: String,
    pub season: i32,
    pub home_before: f64,
    pub away_before: f64,
    pub expected_home_score: f64,
    pub observed_home_score: f64,
    pub home_after: f64,
    pub away_after: f64,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct EloSeed {
    pub schema_version: u32,
    pub league: String,
    pub target_season: i32,
    pub through_season: i32,
    pub generated_at: String,
    pub history_sha256: String,
    pub config_sha256: String,
    pub settings: EloSettings,
    pub completed_games: usize,
    pub tied_games: usize,
    pub tie_weight: f64,
    pub ratings: Vec<Rating>,
    pub audit: Vec<Audit>,
}

pub fn digest(bytes: &[u8]) -> String {
    // sha2 0.11 returns a hybrid_array::Array, which no longer implements LowerHex.
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(hex, "{byte:02x}").expect("Writing to a String cannot fail");
    }
    hex
}

pub fn load_config(path: &Path) -> Result<(LeagueConfig, Vec<u8>)> {
    let bytes = fs::read(path).with_context(|| format!("Read config {}", path.display()))?;
    let config: LeagueConfig = serde_json::from_slice(&bytes)?;
    config.validate()?;
    Ok((config, bytes))
}

impl LeagueConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.schema_version == 1, "Unsupported config schema");
        ensure!(
            !self.id.is_empty() && self.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "Unsafe league id"
        );
        ensure!(
            (1..=12).contains(&self.season_rollover_month),
            "Invalid season rollover month"
        );
        ensure!((1900..=2200).contains(&self.history_start), "Invalid historical start");
        ensure!(
            ["nflverse-csv", "canonical-json"].contains(&self.source.kind.as_str()),
            "Unknown source adapter"
        );
        ensure!(self.source.url.starts_with("https://"), "Source URL must use HTTPS");
        ensure!(self.teams.len() >= 2, "At least two teams required");
        let ids: BTreeSet<_> = self.teams.iter().map(|t| t.id.as_str()).collect();
        ensure!(ids.len() == self.teams.len(), "Duplicate team ids");
        ensure!(
            self.teams.iter().all(|t| !t.id.is_empty() && !t.name.is_empty()),
            "Empty team id or name"
        );
        ensure!(
            self.aliases.values().all(|id| ids.contains(id.as_str())),
            "Alias points to unknown team"
        );
        ensure!(
            self.aliases
                .iter()
                .all(|(from, to)| !ids.contains(from.as_str()) || from == to),
            "Alias shadows a canonical team"
        );
        for team in &self.teams {
            ensure!(!team.eras.is_empty(), "Missing team identity history: {}", team.id);
            ensure!(
                team.eras[0].from_season <= self.history_start,
                "Team identity history starts too late: {}",
                team.id
            );
            for (i, era) in team.eras.iter().enumerate() {
                ensure!(
                    !era.name.is_empty() && !era.location.is_empty() && !era.source_ids.is_empty(),
                    "Incomplete team era: {}",
                    team.id
                );
                ensure!(
                    era.through_season.is_none_or(|end| end >= era.from_season),
                    "Invalid team era range"
                );
                ensure!(
                    era.source_ids.iter().all(|id| self.team_id(id) == team.id),
                    "Historical abbreviation points to another franchise"
                );
                if let Some(next) = team.eras.get(i + 1) {
                    ensure!(
                        era.through_season == Some(next.from_season - 1),
                        "Team eras overlap or have a gap: {}",
                        team.id
                    );
                } else {
                    ensure!(
                        era.through_season.is_none() && era.name == team.name && era.location == team.location,
                        "Latest identity must match current team metadata"
                    );
                }
            }
        }
        ensure!(
            self.ties_allowed_in
                .iter()
                .all(|s| ["regular", "postseason"].contains(&s.as_str())),
            "Unknown phase in tie rules"
        );
        let e = &self.elo;
        ensure!(
            [e.initial, e.scale, e.k, e.home_advantage, e.offseason_regression]
                .iter()
                .all(|x| x.is_finite()),
            "Non-finite Elo parameter"
        );
        ensure!(
            e.scale > 0.0 && e.k > 0.0 && (0.0..=1.0).contains(&e.offseason_regression),
            "Invalid Elo parameters"
        );
        let b = &self.bayesian;
        ensure!(
            b.prior_sd_elo.is_finite()
                && b.prior_sd_elo > 0.0
                && b.tie_prior_games.is_finite()
                && b.tie_prior_games > 0.0
                && b.tie_prior_rate > 0.0
                && b.tie_prior_rate < 1.0,
            "Invalid Bayesian parameters"
        );
        Ok(())
    }
    pub fn current_season(&self) -> i32 {
        let today = Utc::now().date_naive();
        today.year() - i32::from(today.month() < self.season_rollover_month)
    }
    pub fn team_id(&self, value: &str) -> String {
        self.aliases.get(value).cloned().unwrap_or_else(|| value.to_owned())
    }
    pub fn identity(&self, id: &str, season: i32) -> Result<&TeamEra> {
        self.teams
            .iter()
            .find(|t| t.id == id)
            .and_then(|t| {
                t.eras
                    .iter()
                    .find(|e| season >= e.from_season && e.through_season.is_none_or(|end| season <= end))
            })
            .with_context(|| format!("No historical identity for {id} in {season}"))
    }
}

#[derive(Deserialize)]
struct SourceGame {
    id: String,
    league: String,
    season: i32,
    #[serde(default)]
    date: String,
    /// Source-local HH:mm, or null when the source does not supply a kickoff.
    time: Option<String>,
    timezone: String,
    phase: String,
    round: String,
    week: u32,
    home_team: String,
    away_team: String,
    home_source_id: String,
    away_source_id: String,
    neutral: bool,
    result: Option<Outcome>,
}

impl SourceGame {
    fn normalize(self, warn: &mut impl FnMut(String)) -> Result<Game> {
        Ok(Game {
            kickoff_utc: time::kickoff_utc(&self, warn)?,
            id: self.id,
            league: self.league,
            season: self.season,
            phase: self.phase,
            round: self.round,
            week: self.week,
            home_team: self.home_team,
            away_team: self.away_team,
            home_source_id: self.home_source_id,
            away_source_id: self.away_source_id,
            neutral: self.neutral,
            result: self.result,
        })
    }
}

#[derive(Deserialize)]
struct CsvGame {
    game_id: String,
    season: i32,
    game_type: String,
    week: u32,
    #[serde(default)]
    gameday: String,
    #[serde(default)]
    gametime: Option<String>,
    away_team: String,
    home_team: String,
    away_score: Option<u32>,
    home_score: Option<u32>,
    location: String,
}

/// Provider adapters normalize into the same league-independent game contract.
pub fn parse_source(text: &str, cfg: &LeagueConfig) -> Result<Vec<Game>> {
    parse_source_with_warnings(text, cfg, |_| {})
}

pub fn parse_source_with_warnings(text: &str, cfg: &LeagueConfig, mut warn: impl FnMut(String)) -> Result<Vec<Game>> {
    let mut games = Vec::new();
    match cfg.source.kind.as_str() {
        "nflverse-csv" => {
            let mut reader = csv::Reader::from_reader(text.as_bytes());
            for row in reader.deserialize::<CsvGame>() {
                let r = row.context("Malformed nflverse CSV row")?;
                if r.season < cfg.history_start {
                    continue;
                }
                let phase = match r.game_type.as_str() {
                    "REG" => "regular",
                    "WC" | "DIV" | "CON" | "SB" => "postseason",
                    "PRE" | "PRO" | "PB" => continue,
                    other => bail!("Unknown game type: {other}"),
                };
                let result = match (r.home_score, r.away_score) {
                    (None, None) => None,
                    (Some(h), Some(a)) => Some(if h > a {
                        Outcome::HomeWin
                    } else if h < a {
                        Outcome::AwayWin
                    } else {
                        Outcome::Tie
                    }),
                    _ => bail!("Only one score present for {}", r.game_id),
                };
                ensure!(
                    ["Home", "Neutral"].contains(&r.location.as_str()),
                    "Unknown location for {}",
                    r.game_id
                );
                games.push(SourceGame {
                    id: r.game_id,
                    league: cfg.id.clone(),
                    season: r.season,
                    date: r.gameday,
                    time: r.gametime,
                    timezone: "America/New_York".into(),
                    phase: phase.into(),
                    round: r.game_type,
                    week: r.week,
                    home_team: cfg.team_id(&r.home_team),
                    away_team: cfg.team_id(&r.away_team),
                    home_source_id: r.home_team,
                    away_source_id: r.away_team,
                    neutral: r.location == "Neutral",
                    result,
                });
            }
        }
        "canonical-json" => {
            #[derive(Deserialize)]
            struct Input {
                schema_version: u32,
                league: String,
                games: Vec<SourceGame>,
            }
            let input: Input = serde_json::from_str(text)?;
            ensure!(
                input.schema_version == 1 && input.league == cfg.id,
                "Incompatible source envelope"
            );
            games = input.games;
            for g in &mut games {
                g.home_team = cfg.team_id(&g.home_team);
                g.away_team = cfg.team_id(&g.away_team);
            }
        }
        _ => bail!("Unknown source adapter"),
    }
    let mut games = games
        .into_iter()
        .map(|g| g.normalize(&mut warn))
        .collect::<Result<Vec<_>>>()?;
    validate_games(&mut games, cfg)?;
    Ok(games)
}

pub fn validate_games(games: &mut [Game], cfg: &LeagueConfig) -> Result<()> {
    let ids: BTreeSet<_> = cfg.teams.iter().map(|t| t.id.as_str()).collect();
    let mut seen = BTreeSet::new();
    for g in games.iter() {
        ensure!(!g.id.is_empty() && seen.insert(&g.id), "Empty or duplicate game id: {}", g.id);
        ensure!(g.league == cfg.id, "Wrong league for {}", g.id);
        ensure!(
            ids.contains(g.home_team.as_str()) && ids.contains(g.away_team.as_str()),
            "Unknown team for {}",
            g.id
        );
        ensure!(g.home_team != g.away_team, "Team playing itself: {}", g.id);
        for (team, source) in [(&g.home_team, &g.home_source_id), (&g.away_team, &g.away_source_id)] {
            ensure!(
                cfg.team_id(source) == *team,
                "Source id does not match franchise for {}",
                g.id
            );
            let era = cfg.identity(team, g.season)?;
            ensure!(
                cfg.source.kind != "nflverse-csv" || era.source_ids.contains(source),
                "Source team abbreviation is invalid for season {} in {}",
                g.season,
                g.id
            );
        }
        ensure!(g.week > 0, "Invalid week");
        ensure!(["regular", "postseason"].contains(&g.phase.as_str()), "Invalid phase");
        ensure!(
            g.result != Some(Outcome::Tie) || cfg.ties_allowed_in.contains(&g.phase),
            "Tie in a phase that forbids ties: {}",
            g.id
        );
    }
    games.sort_by(|a, b| (a.season, a.kickoff_utc, &a.id).cmp(&(b.season, b.kickoff_utc, &b.id)));
    Ok(())
}

pub fn fetch_source(url: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent("game-results-prediction/0.1")
        .build()?;
    let mut last = None;
    for attempt in 0..3 {
        match client
            .get(url)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.text())
        {
            Ok(body) => return Ok(body),
            Err(error) => {
                last = Some(error);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_secs(1 << attempt));
                }
            }
        }
    }
    Err(last.unwrap().into())
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().context("Output needs a parent directory")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temp, value)?;
    temp.write_all(b"\n")?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    // Only POSIX lets a directory be opened as a file to durably record the rename.
    // On Windows the rename is already atomic and the handle would be denied.
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

/// Advisory lock is released by the OS even if the process crashes.
pub fn lock(path: &Path) -> Result<File> {
    fs::create_dir_all(path.parent().context("Lock needs a parent directory")?)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    fs2::FileExt::try_lock_exclusive(&file).context("Another process is writing this output; try again after it finishes")?;
    Ok(file)
}

pub fn build_seed(
    history: &GameFile,
    history_bytes: &[u8],
    cfg: &LeagueConfig,
    config_bytes: &[u8],
    target: i32,
) -> Result<EloSeed> {
    cfg.validate()?;
    ensure!(
        history.teams == cfg.teams,
        "Team identity history changed; rerun history-importer before elo-ratings"
    );
    ensure!(
        history.schema_version == HISTORY_SCHEMA_VERSION && history.league == cfg.id,
        "Incompatible history file; rerun history-importer"
    );
    ensure!(
        history.from_season == cfg.history_start && history.through_season == target - 1,
        "History must cover {} through {}. Run history-importer first.",
        cfg.history_start,
        target - 1
    );
    ensure!(
        history
            .games
            .iter()
            .all(|g| g.season >= cfg.history_start && g.season < target),
        "History contains a game outside its declared training period"
    );
    let EloReplay { mut ratings, audit } = replay_elo(&history.games, cfg, target - 1)?;
    let games: BTreeMap<_, _> = history.games.iter().map(|g| (g.id.as_str(), g)).collect();
    let mut tie_eligible = Vec::new();
    let mut tied = 0;
    for entry in &audit {
        let g = games[entry.game_id.as_str()];
        if cfg.ties_allowed_in.contains(&g.phase) {
            let advantage = if g.neutral { 0.0 } else { cfg.elo.home_advantage };
            tie_eligible.push(std::f64::consts::LN_10 * (entry.home_before - entry.away_before + advantage) / cfg.elo.scale);
            if g.result == Some(Outcome::Tie) {
                tied += 1;
            }
        }
    }
    // Apply exactly one offseason regression between the final historical season and the target.
    for r in &mut ratings {
        r.elo = regress_rating(r.elo, &cfg.elo);
    }
    // Estimate Davidson's tie weight from pre-game historical differences, with
    // configurable pseudo-games to keep the estimate positive when ties are rare.
    let desired = tied as f64 + cfg.bayesian.tie_prior_games * cfg.bayesian.tie_prior_rate;
    let (mut low, mut high) = (-25.0_f64, 25.0_f64);
    for _ in 0..100 {
        let mid = (low + high) / 2.0;
        let nu = mid.exp();
        let expected_ties: f64 = tie_eligible.iter().map(|d| nu / (2.0 * (d / 2.0).cosh() + nu)).sum::<f64>()
            + cfg.bayesian.tie_prior_games * nu / (2.0 + nu);
        if expected_ties < desired {
            low = mid;
        } else {
            high = mid;
        }
    }
    Ok(EloSeed {
        schema_version: 1,
        league: cfg.id.clone(),
        target_season: target,
        through_season: target - 1,
        generated_at: Utc::now().to_rfc3339(),
        history_sha256: digest(history_bytes),
        config_sha256: digest(config_bytes),
        settings: cfg.elo.clone(),
        completed_games: audit.len(),
        tied_games: tied,
        tie_weight: ((low + high) / 2.0).exp(),
        ratings,
        audit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> EloSettings {
        EloSettings {
            initial: 1500.0,
            scale: 400.0,
            k: 20.0,
            home_advantage: 55.0,
            offseason_regression: 1.0 / 3.0,
        }
    }
    #[test]
    fn elo_symmetry_and_neutral_venue() {
        let e = settings();
        assert_eq!(expected_home(1500.0, 1500.0, true, &e), 0.5);
        assert!(expected_home(1500.0, 1500.0, false, &e) > 0.5);
        assert!((expected_home(1600.0, 1400.0, true, &e) + expected_home(1400.0, 1600.0, true, &e) - 1.0).abs() < 1e-12);
    }
    #[test]
    fn tie_moves_favorite_down() {
        let e = settings();
        let delta = e.k * (0.5 - expected_home(1600.0, 1400.0, true, &e));
        assert!(delta < 0.0);
        assert!((1600.0 + delta + 1400.0 - delta - 3000.0).abs() < 1e-12);
    }
}
