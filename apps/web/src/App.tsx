import { useEffect, useMemo, useState } from 'react';
import { currentSeason } from './contracts.ts';
import { PredictionService, message, type PublicState } from './service.ts';
import type { Prediction } from './model.ts';
import { readConfig } from './storage.ts';

const base = import.meta.env.BASE_URL;
const percent = (p: number) => `${(100 * p).toFixed(1)}%`;
const number = (n: number) => Math.round(n).toLocaleString();

export default function App() {
  const [service, setService] = useState<PredictionService | null>(null);
  const [state, setState] = useState<PublicState | null>(null),
    [error, setError] = useState('');
  const [home, setHome] = useState(''),
    [away, setAway] = useState(''),
    [neutral, setNeutral] = useState(false);
  const [phase, setPhase] = useState<'regular' | 'postseason'>('regular');
  const [tab, setTab] = useState<'scheduled' | 'completed' | 'awaiting_result'>('scheduled');
  const [week, setWeek] = useState('all');
  useEffect(() => {
    const abort = new AbortController();
    let live = true;
    // The model runs in the browser: published Elo seeds plus a live provider refresh.
    void (async () => {
      try {
        const { config, hash } = await readConfig(`${base}config/nfl.json`, abort.signal);
        const instance = new PredictionService({
          config,
          configHash: hash,
          dataBase: `${base}data`,
          season: currentSeason(config),
        });
        if (!live) return;
        setState(instance.getState());
        await instance.initialize();
        if (!live) return;
        const s = instance.getState();
        setService(instance);
        setState(s);
        if (s.status === 'ready') {
          const next = s.games.find((g) => g.status === 'scheduled');
          setHome(next?.home_team ?? s.teams[0]?.id ?? '');
          setAway(next?.away_team ?? s.teams[1]?.id ?? '');
          setNeutral(next?.neutral ?? false);
          setPhase(next?.phase ?? 'regular');
        }
      } catch (e) {
        if (live && !abort.signal.aborted) setError(message(e));
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, []);
  // Predicting is a pure function of the fitted model, so it is derived, never stored.
  const { prediction, predictionError } = useMemo<{
    prediction: Prediction | null;
    predictionError: string;
  }>(() => {
    if (!service || state?.status !== 'ready' || !home || !away) return { prediction: null, predictionError: '' };
    if (home === away)
      return {
        prediction: null,
        predictionError: 'Choose two different teams.',
      };
    try {
      return {
        prediction: service.predict(home, away, neutral, phase),
        predictionError: '',
      };
    } catch (e) {
      return { prediction: null, predictionError: message(e) };
    }
  }, [service, state?.status, home, away, neutral, phase]);
  const teams = [...(state?.teams ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const teamLabel = (id: string) => teams.find((t) => t.id === id)?.abbreviation ?? id;
  const games = (state?.games ?? []).filter((g) => g.status === tab && (week === 'all' || String(g.round) === week));
  const weeks = [...new Set((state?.games ?? []).map((g) => g.round))].sort((a, b) => a - b);
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            ↗
          </span>
          <span>
            Game Results <strong>Prediction</strong>
          </span>
        </div>
        <span className="tag">
          {state?.league ?? 'NFL'} · {state?.season ?? 'Season'}
        </span>
      </header>
      <main>
        <div className="intro">
          <div>
            <p className="eyebrow">TEAM STRENGTH / MATCHUP PROBABILITIES</p>
            <h1>
              Every game starts
              <br />
              <span>with a probability.</span>
            </h1>
            <p className="lede">Historical Elo sets the starting point. This season’s results update the picture.</p>
          </div>
          <div className="status-card">
            <span className={`status-dot ${state?.status === 'ready' ? 'ready' : ''}`} aria-hidden="true" />
            <strong>
              {state?.status === 'ready'
                ? state.cached
                  ? 'Using cached results'
                  : 'Season refreshed'
                : state?.status === 'error'
                  ? 'Setup needed'
                  : 'Refreshing season'}
            </strong>
            <small>{state?.refreshed_at ? new Date(state.refreshed_at).toLocaleString() : 'Checking the latest game data…'}</small>
            <small>Refreshes each time the page loads</small>
          </div>
        </div>
        {error && (
          <div role="alert" className="notice error">
            {error} Reload the page to try again.
          </div>
        )}
        {state?.warning && (
          <div role="status" className="notice">
            {state.warning}
          </div>
        )}
        {state?.status === 'error' && (
          <div role="alert" className="notice error">
            <strong>The model is not ready.</strong>
            <p>{state.error}</p>
            <p>See the README for the historical import and Elo setup commands, then rebuild and republish the site.</p>
          </div>
        )}
        {(!state || state.status === 'loading') && !error && (
          <section className="panel loading" aria-live="polite">
            <span className="spinner" />
            Downloading current-season games and fitting the model…
          </section>
        )}
        {state?.status === 'ready' && (
          <>
            <section className="metrics" aria-label="Data overview">
              <div>
                <small>HISTORICAL GAMES</small>
                <strong>{number(state.historical_games)}</strong>
                <span>
                  {state.history_start}–{state.season - 1} · regular + postseason
                </span>
              </div>
              <div>
                <small>THIS SEASON’S RESULTS</small>
                <strong>{state.training_games}</strong>
                <span>Wins, losses, and ties</span>
              </div>
              <div>
                <small>TEAMS IN THE MODEL</small>
                <strong>{state.teams.length}</strong>
                <span>Elo priors + Bayesian updates</span>
              </div>
            </section>
            <section className="panel matchup">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">EXPLORE A MATCHUP</p>
                  <h2>Who has the edge?</h2>
                </div>
                <span className="chip">{phase === 'regular' ? 'Regular season' : 'Postseason'}</span>
              </div>
              <div className="matchup-controls">
                <label>
                  {neutral ? 'Team A' : 'Home team'}
                  <select aria-label={neutral ? 'Team A' : 'Home team'} value={home} onChange={(e) => setHome(e.target.value)}>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="swap"
                  title="Swap teams"
                  aria-label="Swap teams"
                  onClick={() => {
                    setHome(away);
                    setAway(home);
                  }}
                >
                  ⇄
                </button>
                <label>
                  {neutral ? 'Team B' : 'Away team'}
                  <select aria-label={neutral ? 'Team B' : 'Away team'} value={away} onChange={(e) => setAway(e.target.value)}>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="options">
                <label className="checkbox">
                  <input type="checkbox" checked={neutral} onChange={(e) => setNeutral(e.target.checked)} /> Neutral venue
                </label>
                <label className="phase-label">
                  Game type{' '}
                  <select value={phase} onChange={(e) => setPhase(e.target.value as typeof phase)}>
                    <option value="regular">Regular season</option>
                    <option value="postseason">Postseason</option>
                  </select>
                </label>
              </div>
              {predictionError && (
                <p role="alert" className="inline-error">
                  {predictionError}
                </p>
              )}
              {prediction ? (
                <div className="prediction" aria-live="polite">
                  <div className="prediction-numbers">
                    <div>
                      <span className="team-code">{teamLabel(home)}</span>
                      <strong>{percent(prediction.home_win)}</strong>
                      <small>{teamName(home)} win</small>
                    </div>
                    <div className="tie-probability">
                      <span>TIE</span>
                      <strong>{percent(prediction.tie)}</strong>
                      <small>
                        {phase === 'postseason' && state.league === 'NFL' ? 'No ties in NFL playoffs' : 'Draw probability'}
                      </small>
                    </div>
                    <div className="away-probability">
                      <span className="team-code">{teamLabel(away)}</span>
                      <strong>{percent(prediction.away_win)}</strong>
                      <small>{teamName(away)} win</small>
                    </div>
                  </div>
                  <div
                    className="probability-bar"
                    role="img"
                    aria-label={`${home} win ${percent(prediction.home_win)}, tie ${percent(prediction.tie)}, ${away} win ${percent(prediction.away_win)}`}
                  >
                    <span className="bar-home" style={{ width: percent(prediction.home_win) }} />
                    <span className="bar-tie" style={{ width: percent(prediction.tie) }} />
                    <span className="bar-away" style={{ width: percent(prediction.away_win) }} />
                  </div>
                  <p className="prediction-note">
                    {teamLabel(home)} win-probability uncertainty:{' '}
                    <strong>
                      {percent(prediction.home_probability_interval[0])}–{percent(prediction.home_probability_interval[1])}
                    </strong>{' '}
                    <span>(approximate 95% credible interval)</span>
                  </p>
                </div>
              ) : (
                !predictionError && <p className="muted">Calculating matchup…</p>
              )}
            </section>
            <div className="columns">
              <section className="panel schedule">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">THE SEASON</p>
                    <h2>Game tracker</h2>
                  </div>
                  <label className="week-label">
                    Week
                    <select value={week} onChange={(e) => setWeek(e.target.value)}>
                      <option value="all">All weeks</option>
                      {weeks.map((w) => (
                        <option key={w} value={w}>
                          {w}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="tabs" role="group" aria-label="Game status">
                  <button aria-pressed={tab === 'scheduled'} onClick={() => setTab('scheduled')}>
                    Upcoming
                  </button>
                  <button aria-pressed={tab === 'completed'} onClick={() => setTab('completed')}>
                    Completed
                  </button>
                  <button aria-pressed={tab === 'awaiting_result'} onClick={() => setTab('awaiting_result')}>
                    Awaiting result
                  </button>
                </div>
                {tab === 'completed' && <p className="muted">Pregame expectations use prior-day results only.</p>}
                <div className="game-list">
                  {games.length === 0 ? (
                    <p className="empty">No games in this view.</p>
                  ) : (
                    games.map((g) => (
                      <article className="game" key={g.id}>
                        <div className="game-meta">
                          Kickoff {g.date} · Week {g.round} {g.phase === 'postseason' && '· Playoffs'} {g.neutral && '· Neutral'}
                        </div>
                        <div className="game-row">
                          <div>
                            <strong title={teamName(g.away_team)}>{teamLabel(g.away_team)}</strong>
                            <span className="at">{g.neutral ? 'vs' : 'at'}</span>
                            <strong title={teamName(g.home_team)}>{teamLabel(g.home_team)}</strong>
                          </div>
                          {g.status === 'completed' ? (
                            <div className="game-outcome">
                              <span className="result-label">
                                {g.result === 'tie'
                                  ? 'Tie'
                                  : `${teamLabel(g.result === 'home_win' ? g.home_team : g.away_team)} won`}
                              </span>
                              {g.prediction && (
                                <span className="game-expectation">
                                  Expected: {teamLabel(g.prediction.home_win >= g.prediction.away_win ? g.home_team : g.away_team)}{' '}
                                  {percent(Math.max(g.prediction.home_win, g.prediction.away_win))}
                                </span>
                              )}
                            </div>
                          ) : g.prediction ? (
                            <button
                              className="game-pick"
                              onClick={() => {
                                setHome(g.home_team);
                                setAway(g.away_team);
                                setNeutral(g.neutral);
                                setPhase(g.phase);
                                document.querySelector('.matchup')?.scrollIntoView({
                                  behavior: 'smooth',
                                  block: 'start',
                                });
                              }}
                            >
                              {teamLabel(g.prediction.home_win >= g.prediction.away_win ? g.home_team : g.away_team)}{' '}
                              {percent(Math.max(g.prediction.home_win, g.prediction.away_win))} <span aria-hidden="true">↗</span>
                            </button>
                          ) : (
                            <span className="muted">Awaiting confirmed result</span>
                          )}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>
              <section className="panel rankings">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">TEAM RATINGS</p>
                    <h2>Strength board</h2>
                  </div>
                </div>
                <p className="table-note">Current Bayesian estimates on the Elo scale. ± is one standard deviation.</p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Team</th>
                        <th scope="col">Initial</th>
                        <th scope="col">Current ± SD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.teams.map((t, i) => (
                        <tr key={t.id}>
                          <th scope="row">
                            <span className="rank">{i + 1}</span>
                            <abbr title={t.name}>{t.abbreviation}</abbr>
                          </th>
                          <td>{number(t.initial_elo)}</td>
                          <td>
                            <strong>{number(t.rating)}</strong>
                            <span className="sd"> ±{number(t.sd)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
            <details className="panel methodology">
              <summary>Franchise names and locations over time</summary>
              <div>
                <p>
                  Ratings follow a permanent franchise ID. Names and locations reflect the season in which each game was played; a
                  relocation or rename does not create a new rating.
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Franchise ID</th>
                        <th>Seasons</th>
                        <th>Name / location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.team_history
                        .filter((t) => t.eras.length > 1)
                        .flatMap((t) =>
                          t.eras.map((e) => (
                            <tr key={`${t.id}-${e.from_season}`}>
                              <th>{t.id}</th>
                              <td>
                                {e.from_season}–{e.through_season ?? 'present'}
                              </td>
                              <td>
                                {e.name}
                                <br />
                                <span className="sd">{e.location}</span>
                              </td>
                            </tr>
                          )),
                        )}
                    </tbody>
                  </table>
                </div>
                <p>
                  Location means the franchise’s home market or region. Venue changes within a market do not change its identity.
                </p>
              </div>
            </details>
            <details className="panel methodology">
              <summary>How these predictions work</summary>
              <div>
                <p>
                  Historical games determine Elo ratings, with ties scored as half a win. An offseason adjustment moves ratings
                  toward the league average. Those ratings become the prior means for a Bayesian model of team strength.
                </p>
                <p>
                  The model learns from this season’s wins, losses, and ties, accounts for the opponent and venue, and integrates
                  over uncertainty to estimate matchup probabilities. It uses a Davidson extension of the Bradley–Terry model with a
                  Laplace approximation. It does not use scores, injuries, rosters, or betting markets.
                </p>
                <p>{state.result_policy} Games without a confirmed outcome do not update the ratings.</p>
                <p>
                  The parameters are starting settings, not a claim of validated forecasting accuracy. The project includes a
                  chronological backtest command.
                </p>
                <a href={state.source} target="_blank" rel="noreferrer">
                  View the data source ↗
                </a>
              </div>
            </details>
          </>
        )}
        <footer>
          Capper Zone <span>Results only. Uncertainty included.</span>
        </footer>
      </main>
    </>
  );
}
