use crate::SourceGame;
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

pub(crate) fn start_time_utc(game: &SourceGame, warn: &mut dyn FnMut(String)) -> Result<DateTime<Utc>> {
    ensure!(!game.date.trim().is_empty(), "Missing source date for game {}", game.id);
    let date = NaiveDate::parse_from_str(&game.date, "%Y-%m-%d")
        .with_context(|| format!("Invalid source date {:?} for game {}", game.date, game.id))?;
    let zone: Tz = game
        .timezone
        .parse()
        .with_context(|| format!("Invalid source timezone {:?} for game {}", game.timezone, game.id))?;
    let time = match game.time.as_deref().filter(|t| !t.trim().is_empty()) {
        Some(time) => NaiveTime::parse_from_str(time, "%H:%M")
            .with_context(|| format!("Invalid source time {time:?} for game {}", game.id))?,
        None => {
            warn(format!(
                "Game {}: missing time on {} in {}; assuming local midnight",
                game.id, date, zone
            ));
            NaiveTime::MIN
        }
    };
    let mut local = date.and_time(time);
    let mut result = zone.from_local_datetime(&local);
    if result == LocalResult::None {
        warn(format!(
            "Game {}: nonexistent local time {local} in {zone}; assuming local midnight",
            game.id
        ));
        local = date.and_time(NaiveTime::MIN);
        result = zone.from_local_datetime(&local);
    }
    if let LocalResult::Ambiguous(earlier, later) = &result {
        warn(format!(
            "Game {}: ambiguous local time {local} in {zone}; choosing {} instead of {} (earlier occurrence)",
            game.id,
            earlier.with_timezone(&Utc).to_rfc3339(),
            later.with_timezone(&Utc).to_rfc3339()
        ));
    }
    result.earliest().map(|t| t.with_timezone(&Utc)).with_context(|| {
        format!(
            "Game {}: local midnight on {date} does not exist in {zone}; cannot convert source date",
            game.id
        )
    })
}
