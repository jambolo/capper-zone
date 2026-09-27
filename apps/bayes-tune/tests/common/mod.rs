use rating_core::{BayesianSettings, EloTuneSettings, Game, GameFile, HISTORY_SCHEMA_VERSION, LeagueConfig, Outcome};

pub fn fixture() -> (LeagueConfig, GameFile) {
    let mut cfg: LeagueConfig = serde_json::from_str(include_str!("../../../../config/nfl.json")).unwrap();
    cfg.teams.retain(|t| ["ARI", "ATL", "BAL"].contains(&t.id.as_str()));
    cfg.aliases.clear();
    cfg.source.kind = "canonical-json".into();
    cfg.source.url = "https://invalid.example.test/no-network-needed".into();
    cfg.bayesian = BayesianSettings {
        prior_sd_elo: 150.0,
        tie_prior_games: 100.0,
        tie_prior_rate: 0.005,
    };
    cfg.bayes_tune = None;
    cfg.elo_tune = Some(EloTuneSettings {
        tune_start: 2003,
        tune_end: 2004,
        test_end: 2005,
    });
    let games = (2002..=2005)
        .flat_map(|season| {
            (1..=4).map(move |round| Game {
                id: format!("{season}-{round}"),
                league: "nfl".into(),
                season,
                start_time_utc: format!("{season}-09-{:02}T17:00:00Z", round * 7).parse().unwrap(),
                phase: if round == 4 { "postseason" } else { "regular" }.into(),
                round_label: if round == 4 { "SB" } else { "REG" }.into(),
                round,
                home_team: "ARI".into(),
                away_team: "ATL".into(),
                home_source_id: "ARI".into(),
                away_source_id: "ATL".into(),
                neutral: round == 4,
                result: Some(if round == 2 {
                    Outcome::Tie
                } else if round == 3 {
                    Outcome::AwayWin
                } else {
                    Outcome::HomeWin
                }),
            })
        })
        .collect();
    let history = GameFile {
        schema_version: HISTORY_SCHEMA_VERSION,
        league: cfg.id.clone(),
        fetched_at: "2006-03-01T00:00:00Z".into(),
        source_url: cfg.source.url.clone(),
        from_season: 2002,
        through_season: 2005,
        teams: cfg.teams.clone(),
        games,
    };
    (cfg, history)
}
