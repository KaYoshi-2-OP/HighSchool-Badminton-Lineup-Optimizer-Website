"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClaudeImportAssistant from "./claude-import-assistant";

type School = { id: string; name: string };
type Player = {
  id: string;
  schoolId: string;
  playerCode: string;
  displayName: string;
  gender: "Boys" | "Girls";
  rank: number;
  initialElo: number;
  currentElo: number;
  firstSeason: number;
  lastSeason: number;
  active: boolean;
};
type Position = { position: string; currentElo: number; totalWeight: number; matchesUsed: number };
type SeasonFormat = {
  season: number;
  boysSingles: number;
  girlsSingles: number;
  boysDoubles: number;
  girlsDoubles: number;
  mixedDoubles: number;
  eventOrder: string[];
  totalEvents: number;
  winsNeeded: number;
  requiredBoys: number;
  requiredGirls: number;
  configured: boolean;
};
type DashboardData = {
  schools: School[];
  selectedHome: School;
  selectedOpponent: School | null;
  homeLocked: boolean;
  players: Player[];
  positions: Position[];
  rosterSeason: number;
  seasonFormat: SeasonFormat;
  seasonFormats: SeasonFormat[];
  yearWeights: Array<{ year: number; weight: number }>;
  matchCount: number;
  returningPlayers: number;
  historicalFit: {
    actualWinsPerMeet: number;
    projectedWinsPerMeet: number;
    meetCount: number;
    eloOffset: number;
  } | null;
  demo: boolean;
};
type LineupRow = {
  event: string;
  playerCodes: string[];
  playerNames: string[];
  playerElo: number;
  opponentElo: number;
  winProbability: number;
};
type Optimization = { lineup: LineupRow[]; expectedWins: number; rawExpectedWins: number; searches: number };
type RatingChange = { oldElo: number; change: number; newElo: number };
type MeetReceipt = {
  exact: boolean;
  date: string;
  homeSchool: string;
  opponentSchool: string;
  homeWins: number;
  homeLosses: number;
  playerChanges: Array<RatingChange & { code: string; name: string }>;
  positionChanges: Array<RatingChange & { position: string }>;
};
type ResultRow = {
  position: string;
  player1: string;
  player2: string;
  g1Home: string;
  g1Opponent: string;
  g2Home: string;
  g2Opponent: string;
  g3Home: string;
  g3Opponent: string;
};
type Tab = "dashboard" | "players" | "results" | "data";

const defaultEventOrder = [
  "BS1", "BS2", "BS3", "BS4",
  "GS1", "GS2", "GS3", "GS4",
  "BD1", "BD2", "BD3",
  "GD1", "GD2", "GD3",
  "XD1", "XD2", "XD3",
];

const emptyResultRows = (eventOrder: string[]): ResultRow[] => eventOrder.map((position) => ({
  position,
  player1: "",
  player2: "",
  g1Home: "",
  g1Opponent: "",
  g2Home: "",
  g2Opponent: "",
  g3Home: "",
  g3Opponent: "",
}));

const rosterTemplate = `school,season,player_id,name,gender,rank,ladder_size,active
North Valley High,2026,P001,B1,Boys,1,21,1
North Valley High,2026,P002,G1,Girls,1,17,1`;

const defaultFormat = (season: number): SeasonFormat => ({
  season,
  boysSingles: 4,
  girlsSingles: 4,
  boysDoubles: 3,
  girlsDoubles: 3,
  mixedDoubles: 3,
  eventOrder: defaultEventOrder,
  totalEvents: 17,
  winsNeeded: 9,
  requiredBoys: 13,
  requiredGirls: 13,
  configured: false,
});

function formatForSeason(data: DashboardData, season: number) {
  return data.seasonFormats.find((format) => format.season === season)
    ?? (season === data.rosterSeason ? data.seasonFormat : defaultFormat(season));
}

function matchTemplate(data: DashboardData) {
  const date = `${data.seasonFormat.season}-03-01`;
  const header = "date,home_school,opponent_school,position,home_player_1,home_player_2,g1_home,g1_opponent,g2_home,g2_opponent,g3_home,g3_opponent";
  const rows = data.seasonFormat.eventOrder.map((position) =>
    `${date},${data.selectedHome.name},Opponent High,${position},,,,,,,,,`,
  );
  return [header, ...rows].join("\n");
}

function Icon({ name }: { name: "grid" | "users" | "data" | "results" | "shuttle" | "upload" | "check" }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    data: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></>,
    results: <><path d="M9 5h10M9 12h10M9 19h10"/><path d="m3 5 1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2"/></>,
    shuttle: <><path d="m5 4 6 6M8 2l5 6M12 2l3 5M4 8l6 4 6-5-4-5H8Z"/><path d="m10 12 7 8 3-3-4-10"/></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v5h16v-5"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function parseCsv(input: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim()); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2) throw new Error("The CSV needs a header and at least one data row.");
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function downloadTemplate(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function meetWinProbability(probabilities: number[], winsNeeded: number) {
  let distribution = new Array(probabilities.length + 1).fill(0);
  distribution[0] = 1;
  probabilities.forEach((probability, index) => {
    const next = new Array(probabilities.length + 1).fill(0);
    for (let wins = 0; wins <= index; wins += 1) {
      next[wins] += distribution[wins] * (1 - probability);
      next[wins + 1] += distribution[wins] * probability;
    }
    distribution = next;
  });
  return distribution.slice(winsNeeded).reduce((sum, probability) => sum + probability, 0);
}

export default function DashboardClient({ currentUser }: { currentUser: { username: string } }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [data, setData] = useState<DashboardData | null>(null);
  const [opponentId, setOpponentId] = useState("");
  const [optimization, setOptimization] = useState<Optimization | null>(null);
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);
  const [importing, setImporting] = useState<"roster" | "matches" | null>(null);
  const [matchDate, setMatchDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [resultRows, setResultRows] = useState<ResultRow[]>(() => emptyResultRows(defaultEventOrder));
  const [formatDraft, setFormatDraft] = useState({
    season: new Date().getUTCFullYear(),
    boysSingles: 4,
    girlsSingles: 4,
    boysDoubles: 3,
    girlsDoubles: 3,
    mixedDoubles: 3,
  });
  const [savingFormat, setSavingFormat] = useState(false);
  const [receipt, setReceipt] = useState<MeetReceipt | null>(null);
  const [resultAction, setResultAction] = useState<"preview" | "confirm" | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const rosterInput = useRef<HTMLInputElement>(null);
  const matchInput = useRef<HTMLInputElement>(null);
  const matchDateRef = useRef(matchDate);

  const loadData = useCallback(async (nextOpponent?: string) => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (nextOpponent) query.set("opponent", nextOpponent);
      const response = await fetch(`/api/data?${query}`);
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load data.");
      setData(payload);
      setOpponentId(payload.selectedOpponent?.id ?? "");
      setFormatDraft({
        season: payload.seasonFormat.season,
        boysSingles: payload.seasonFormat.boysSingles,
        girlsSingles: payload.seasonFormat.girlsSingles,
        boysDoubles: payload.seasonFormat.boysDoubles,
        girlsDoubles: payload.seasonFormat.girlsDoubles,
        mixedDoubles: payload.seasonFormat.mixedDoubles,
      });
      const resultYear = Number(matchDateRef.current.slice(0, 4));
      const resultFormat = formatForSeason(payload, resultYear);
      setResultRows((current) => current.map((row) => row.position).join("|") === resultFormat.eventOrder.join("|")
        ? current
        : emptyResultRows(resultFormat.eventOrder));
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not load data." });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // The dashboard is intentionally client-loaded because its data is stored
    // in the site's persistent D1 database rather than generated at build time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadData();
  }, [loadData]);

  const changeOpponent = async (value: string) => {
    setOpponentId(value);
    setOptimization(null);
    setReceipt(null);
    await loadData(value);
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/auth", { method: "DELETE" });
    } finally {
      window.location.reload();
    }
  };

  const updateResultRow = (index: number, field: keyof ResultRow, value: string) => {
    setResultRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
    setReceipt(null);
  };

  const matchPayloadRows = () => {
    if (!data?.selectedOpponent) throw new Error("Select an opponent first.");
    if (!matchDate) throw new Error("Enter the meet date.");
    return resultRows.map((row) => ({
      date: matchDate,
      home_school: data.selectedHome.name,
      opponent_school: data.selectedOpponent?.name ?? "",
      position: row.position,
      home_player_1: row.player1,
      home_player_2: row.player2,
      g1_home: row.g1Home,
      g1_opponent: row.g1Opponent,
      g2_home: row.g2Home,
      g2_opponent: row.g2Opponent,
      g3_home: row.g3Home,
      g3_opponent: row.g3Opponent,
    }));
  };

  const submitMeet = async (action: "preview" | "confirm") => {
    setResultAction(action); setNotice(null);
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action === "preview" ? "preview_meet" : "confirm_meet", rows: matchPayloadRows() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The meet could not be processed.");
      const nextReceipt = action === "preview" ? payload : payload.receipt;
      setReceipt(nextReceipt);
      if (action === "preview") {
        setNotice({ tone: "success", text: "Preview ready. Review every change before confirming the meet." });
      } else {
        setNotice({ tone: "success", text: `Meet saved. The final ${nextReceipt.homeWins}–${nextReceipt.homeLosses} result and exact rating changes are shown below.` });
        setOptimization(null);
        await loadData(opponentId);
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The meet could not be processed." });
    } finally { setResultAction(null); }
  };

  const optimize = async () => {
    setOptimizing(true); setNotice(null);
    try {
      if (!data) throw new Error("The school data is still loading.");
      const { optimizeLineup } = await import("../lib/optimizer");
      const result = optimizeLineup(
        data.players,
        data.positions,
        data.historicalFit?.actualWinsPerMeet,
        data.seasonFormat,
      );
      setOptimization(result);
      setNotice({ tone: "success", text: data.historicalFit
        ? `A legal lineup was found and anchored to ${data.historicalFit.meetCount} recorded meet${data.historicalFit.meetCount === 1 ? "" : "s"}.`
        : `A high-scoring legal lineup has been found across ${result.searches} starting configurations.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Optimization failed." });
    } finally { setOptimizing(false); }
  };

  const importFile = async (file: File, kind: "roster" | "matches") => {
    setImporting(kind); setNotice(null);
    try {
      const rows = parseCsv(await file.text());
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind === "roster" ? "import_rosters" : "import_matches", rows }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Import failed.");
      const summary = kind === "roster"
        ? `${payload.created} new players added; ${payload.continued} returning-player records preserved.`
        : `${payload.inserted} results added; ${payload.duplicates} duplicate rows safely skipped.`;
      setNotice({ tone: "success", text: summary });
      setOptimization(null);
      await loadData(opponentId);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Import failed." });
    } finally { setImporting(null); }
  };

  const chooseFormatSeason = (season: number) => {
    const existing = data?.seasonFormats.find((format) => format.season === season)
      ?? defaultFormat(season);
    setFormatDraft({
      season,
      boysSingles: existing.boysSingles,
      girlsSingles: existing.girlsSingles,
      boysDoubles: existing.boysDoubles,
      girlsDoubles: existing.girlsDoubles,
      mixedDoubles: existing.mixedDoubles,
    });
  };

  const saveFormat = async () => {
    setSavingFormat(true); setNotice(null);
    try {
      const response = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_season_format", ...formatDraft }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "The league format could not be saved.");
      await loadData(opponentId);
      const saved = payload.format as SeasonFormat;
      setFormatDraft({
        season: saved.season,
        boysSingles: saved.boysSingles,
        girlsSingles: saved.girlsSingles,
        boysDoubles: saved.boysDoubles,
        girlsDoubles: saved.girlsDoubles,
        mixedDoubles: saved.mixedDoubles,
      });
      setNotice({
        tone: "success",
        text: `${saved.season} saved as a ${saved.totalEvents}-event format. ${saved.winsNeeded} wins are required for an outright meet victory.`,
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The league format could not be saved." });
    } finally { setSavingFormat(false); }
  };

  const changeMatchDate = (value: string) => {
    matchDateRef.current = value;
    setMatchDate(value);
    setReceipt(null);
    if (!data) return;
    const season = Number(value.slice(0, 4));
    const format = formatForSeason(data, season);
    setResultRows(emptyResultRows(format.eventOrder));
  };

  const probabilities = optimization?.lineup.map((row) => row.winProbability) ?? [];
  const meetProbability = probabilities.length && data
    ? meetWinProbability(probabilities, data.seasonFormat.winsNeeded)
    : null;
  const resultSeason = Number(matchDate.slice(0, 4));
  const resultFormat = data ? formatForSeason(data, resultSeason) : defaultFormat(resultSeason);
  const formatTotal = formatDraft.boysSingles + formatDraft.girlsSingles
    + formatDraft.boysDoubles + formatDraft.girlsDoubles + formatDraft.mixedDoubles;
  const formatWinsNeeded = Math.floor(formatTotal / 2) + 1;
  const formatRequiredBoys = formatDraft.boysSingles + 2 * formatDraft.boysDoubles + formatDraft.mixedDoubles;
  const formatRequiredGirls = formatDraft.girlsSingles + 2 * formatDraft.girlsDoubles + formatDraft.mixedDoubles;
  const activePlayers = useMemo(() => data?.players.filter((player) => player.active) ?? [], [data]);
  const playersFor = (position: string, slot: 1 | 2) => {
    const gender = position.startsWith("GS") || position.startsWith("GD") || (position.startsWith("XD") && slot === 2)
      ? "Girls"
      : "Boys";
    return activePlayers.filter((player) => player.gender === gender);
  };
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Icon name="shuttle" /></div>
          <div><strong>Badminton</strong><span>Lineup Optimizer</span></div>
        </div>
        <nav aria-label="Primary navigation">
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}><Icon name="grid" /><span>Dashboard</span></button>
          <button className={tab === "players" ? "active" : ""} onClick={() => setTab("players")}><Icon name="users" /><span>Players</span></button>
          <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}><Icon name="results" /><span>Enter Results</span></button>
          <button className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}><Icon name="data" /><span>Data & Matches</span></button>
        </nav>
        <div className="model-note"><span>MODEL</span><strong>Season-aware Elo</strong><small>Players continue across seasons</small></div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">ONE HOME SCHOOL · MULTI-OPPONENT ANALYTICS</p><h1>{tab === "dashboard" ? "Lineup projection" : tab === "players" ? "Player ratings" : tab === "results" ? "Enter true match results" : "Season setup & historical data"}</h1></div>
          <div className="topbar-actions">
            {data?.demo && <span className="demo-badge">Demo dataset</span>}
            <div className="account-summary" aria-label={`Signed in as ${currentUser.username}`}>
              <span aria-hidden="true">{currentUser.username.charAt(0).toUpperCase()}</span>
              <div><small>SIGNED IN AS</small><strong>{currentUser.username}</strong></div>
            </div>
            <button className="sign-out-button" type="button" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
          </div>
        </header>

        {notice && <div role="status" className={`notice ${notice.tone}`}><Icon name={notice.tone === "success" ? "check" : "data"}/><span>{notice.text}</span><button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}

        {loading && !data ? <div className="loading-panel"><span/><p>Loading the rating system…</p></div> : null}

        {data && tab === "dashboard" && (
          <>
            <section className="control-row" aria-label="Matchup selection">
              <div className="locked-school"><span>HOME SCHOOL · LOCKED</span><strong>{data.selectedHome.name}</strong></div>
              <span className="versus">VS</span>
              <label><span>OPPONENT</span><select value={opponentId} onChange={(event) => void changeOpponent(event.target.value)}>{data.schools.filter((school) => school.id !== data.selectedHome.id).map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></label>
              <button className="primary-button" disabled={optimizing || !opponentId} onClick={() => void optimize()}>{optimizing ? "Optimizing…" : "Optimize Lineup"}</button>
            </section>

            <section className="metric-grid">
              <article><p>Expected Wins</p><strong>{optimization ? optimization.expectedWins.toFixed(2) : "—"}<small>/{data.seasonFormat.totalEvents}</small></strong><span>{optimization ? (data.historicalFit ? "History-anchored lineup projection" : "Best search projection") : `Using the ${data.rosterSeason} league format`}</span></article>
              <article><p>Meet Win Probability</p><strong>{meetProbability === null ? "—" : `${Math.round(meetProbability * 100)}%`}</strong><span>{meetProbability === null ? `Calculated from ${data.seasonFormat.totalEvents} events` : `Probability of at least ${data.seasonFormat.winsNeeded} wins`}</span></article>
              <article><p>Historical Fit</p><strong>{data.historicalFit ? `${data.historicalFit.actualWinsPerMeet.toFixed(1)} ≈ ${data.historicalFit.projectedWinsPerMeet.toFixed(1)}` : "—"}</strong><span>{data.historicalFit ? `Actual vs model across ${data.historicalFit.meetCount} meet${data.historicalFit.meetCount === 1 ? "" : "s"}` : "No recorded meets for this opponent"}</span></article>
            </section>

            <section className="panel lineup-panel">
              <div className="panel-heading"><div><p className="eyebrow">PROJECTED RESULT</p><h2>Optimized lineup</h2></div>{optimization && <span className="status-pill"><Icon name="check"/>Legal lineup verified</span>}</div>
              {optimization ? (
                <div className="table-wrap"><table><thead><tr><th>Event</th><th>Player / Pair</th><th>Player Elo</th><th>Opponent Elo</th><th>Projected Win</th></tr></thead><tbody>{optimization.lineup.map((row) => <tr key={row.event}><td><span className={`event-chip ${row.event.slice(0, 2).toLowerCase()}`}>{row.event}</span></td><td><strong>{row.playerNames.join(" / ")}</strong><small>{row.playerCodes.join(" / ")}</small></td><td>{Math.round(row.playerElo)}</td><td>{Math.round(row.opponentElo)}</td><td><div className="probability"><span>{Math.round(row.winProbability * 100)}%</span><i><b style={{ width: `${Math.round(row.winProbability * 100)}%` }}/></i></div></td></tr>)}</tbody></table></div>
              ) : (
                <div className="empty-lineup"><div className="empty-icon"><Icon name="shuttle"/></div><h3>Ready to calculate a lineup</h3><p>Select an opponent and run the optimizer. The home school is fixed, and the historical calibration keeps the projected score grounded in recorded results while the search compares legal lineups.</p><button className="secondary-button" onClick={() => void optimize()}>Run first projection</button></div>
              )}
            </section>
          </>
        )}

        {data && tab === "players" && (
          <>
            <section className="summary-strip"><div><span>Active roster</span><strong>{activePlayers.length}</strong></div><div><span>Returning players</span><strong>{data.returningPlayers}</strong></div><div><span>Rating rule</span><strong>Continuous</strong></div><button className="primary-button compact" onClick={() => rosterInput.current?.click()}><Icon name="upload"/>Import roster</button></section>
            <section className="panel">
              <div className="panel-heading"><div><p className="eyebrow">{data.selectedHome.name.toUpperCase()}</p><h2>Current player Elo</h2></div><button className="text-button" onClick={() => downloadTemplate("roster_template.csv", rosterTemplate)}>Download CSV template</button></div>
              <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Player</th><th>Gender</th><th>Current Elo</th><th>First season</th><th>Continuity</th></tr></thead><tbody>{activePlayers.map((player) => <tr key={player.id}><td>{player.rank}</td><td><strong>{player.displayName}</strong><small>{player.playerCode}</small></td><td>{player.gender}</td><td><strong>{Math.round(player.currentElo)}</strong></td><td>{player.firstSeason}</td><td>{player.firstSeason < player.lastSeason ? <span className="continuity returning">Returning · carried forward</span> : <span className="continuity">New this season</span>}</td></tr>)}</tbody></table></div>
            </section>
          </>
        )}

        {data && tab === "results" && (
          <div className="results-layout">
            <section className="panel meet-entry-panel">
              <div className="panel-heading result-heading">
                <div><p className="eyebrow">ACTUAL LINEUP + FINAL SCORES</p><h2>Record one complete dual meet</h2></div>
                <span className="status-pill">{resultFormat.totalEvents} required events · {resultSeason}</span>
              </div>
              <div className="meet-details">
                <label><span>MEET DATE</span><input type="date" value={matchDate} onChange={(event) => changeMatchDate(event.target.value)}/></label>
                <div className="locked-school"><span>HOME SCHOOL · LOCKED</span><strong>{data.selectedHome.name}</strong></div>
                <label><span>OPPONENT</span><select value={opponentId} onChange={(event) => void changeOpponent(event.target.value)}>{data.schools.filter((school) => school.id !== data.selectedHome.id).map((school) => <option key={school.id} value={school.id}>{school.name}</option>)}</select></label>
              </div>
              <p className="entry-guidance">Enter the lineup that actually played—not the optimized recommendation. Every player may appear once. Game 3 should remain blank when the event ended in two games.</p>
              <div className="event-entry-list">
                {resultRows.map((row, index) => {
                  const pairEvent = row.position.startsWith("BD") || row.position.startsWith("GD") || row.position.startsWith("XD");
                  return (
                    <article className="event-entry-row" key={row.position}>
                      <span className={`event-chip ${row.position.slice(0, 2).toLowerCase()}`}>{row.position}</span>
                      <div className="player-entry">
                        <select aria-label={`${row.position} player 1`} value={row.player1} onChange={(event) => updateResultRow(index, "player1", event.target.value)}>
                          <option value="">Select {playersFor(row.position, 1)[0]?.gender === "Girls" ? "girl" : "boy"}</option>
                          {playersFor(row.position, 1).map((player) => <option key={player.id} value={player.playerCode}>{player.displayName} · {player.playerCode}</option>)}
                        </select>
                        {pairEvent && <select aria-label={`${row.position} player 2`} value={row.player2} onChange={(event) => updateResultRow(index, "player2", event.target.value)}>
                          <option value="">Select {playersFor(row.position, 2)[0]?.gender === "Girls" ? "girl" : "boy"}</option>
                          {playersFor(row.position, 2).map((player) => <option key={player.id} value={player.playerCode}>{player.displayName} · {player.playerCode}</option>)}
                        </select>}
                      </div>
                      {([1, 2, 3] as const).map((game) => {
                        const homeField = `g${game}Home` as keyof ResultRow;
                        const opponentField = `g${game}Opponent` as keyof ResultRow;
                        return <div className="game-entry" key={game}><small>G{game}</small><input aria-label={`${row.position} game ${game} home score`} inputMode="numeric" min="0" max="99" type="number" placeholder="Us" value={row[homeField]} onChange={(event) => updateResultRow(index, homeField, event.target.value)}/><span>–</span><input aria-label={`${row.position} game ${game} opponent score`} inputMode="numeric" min="0" max="99" type="number" placeholder="Opp" value={row[opponentField]} onChange={(event) => updateResultRow(index, opponentField, event.target.value)}/></div>;
                      })}
                    </article>
                  );
                })}
              </div>
              <div className="entry-actions">
                <div><strong>Nothing is saved during preview.</strong><span>The confirmed update performs a full chronological replay.</span></div>
                <button className="primary-button" disabled={resultAction !== null} onClick={() => void submitMeet("preview")}>{resultAction === "preview" ? "Calculating…" : "Preview Elo Changes"}</button>
              </div>
            </section>

            {receipt && (
              <section className={`panel receipt-panel ${receipt.exact ? "confirmed" : ""}`}>
                <div className="receipt-hero">
                  <div><p className="eyebrow">{receipt.exact ? "CONFIRMED + SAVED" : "PREVIEW · NOT SAVED"}</p><h2>{receipt.homeSchool} {receipt.homeWins}–{receipt.homeLosses} {receipt.opponentSchool}</h2><p>{receipt.exact ? "These are the final stored values after the complete historical replay." : "These estimates use the current ratings. Confirmation recalculates the full history and returns the exact stored values."}</p></div>
                  {receipt.exact ? <button className="secondary-button" onClick={() => { setResultRows(emptyResultRows(resultFormat.eventOrder)); setReceipt(null); }}>Enter another meet</button> : <button className="primary-button" disabled={resultAction !== null} onClick={() => void submitMeet("confirm")}>{resultAction === "confirm" ? "Saving…" : "Confirm and Save Meet"}</button>}
                </div>
                <div className="receipt-tables">
                  <div><h3>Home roster changes</h3><div className="table-wrap"><table><thead><tr><th>Player</th><th>Old Elo</th><th>Change</th><th>New Elo</th></tr></thead><tbody>{receipt.playerChanges.map((change) => <tr key={change.code}><td><strong>{change.name}</strong><small>{change.code}</small></td><td>{change.oldElo.toFixed(1)}</td><td><span className={change.change >= 0 ? "positive-change" : "negative-change"}>{signed(change.change)}</span></td><td><strong>{change.newElo.toFixed(1)}</strong></td></tr>)}</tbody></table></div></div>
                  <div><h3>{receipt.opponentSchool} positional changes</h3><div className="table-wrap"><table><thead><tr><th>Position</th><th>Old Elo</th><th>Change</th><th>New Elo</th></tr></thead><tbody>{receipt.positionChanges.map((change) => <tr key={change.position}><td><span className={`event-chip ${change.position.slice(0, 2).toLowerCase()}`}>{change.position}</span></td><td>{change.oldElo.toFixed(1)}</td><td><span className={change.change >= 0 ? "positive-change" : "negative-change"}>{signed(change.change)}</span></td><td><strong>{change.newElo.toFixed(1)}</strong></td></tr>)}</tbody></table></div></div>
                </div>
              </section>
            )}
          </div>
        )}

        {data && tab === "data" && (
          <div className="data-layout">
          <ClaudeImportAssistant />
            <section className="panel format-panel">
              <div className="panel-heading">
                <div><p className="eyebrow">SEASON LEAGUE FORMAT</p><h2>How many of each event will be played?</h2></div>
                <span className="status-pill">{formatTotal} total events</span>
              </div>
              <p className="format-intro">Save the league format before entering that season’s results. The optimizer, required roster size, result form, opponent positions, projected score, and meet-win threshold all update from these five counts. Existing seasons use the standard 17-event format unless you save a different one.</p>
              <div className="format-controls">
                <label><span>SEASON</span><input type="number" min="1900" max="2200" value={formatDraft.season} onChange={(event) => chooseFormatSeason(Number(event.target.value))}/></label>
                <label><span>BOYS SINGLES</span><input type="number" min="0" max="12" value={formatDraft.boysSingles} onChange={(event) => setFormatDraft((current) => ({ ...current, boysSingles: Number(event.target.value) }))}/></label>
                <label><span>GIRLS SINGLES</span><input type="number" min="0" max="12" value={formatDraft.girlsSingles} onChange={(event) => setFormatDraft((current) => ({ ...current, girlsSingles: Number(event.target.value) }))}/></label>
                <label><span>BOYS DOUBLES</span><input type="number" min="0" max="12" value={formatDraft.boysDoubles} onChange={(event) => setFormatDraft((current) => ({ ...current, boysDoubles: Number(event.target.value) }))}/></label>
                <label><span>GIRLS DOUBLES</span><input type="number" min="0" max="12" value={formatDraft.girlsDoubles} onChange={(event) => setFormatDraft((current) => ({ ...current, girlsDoubles: Number(event.target.value) }))}/></label>
                <label><span>MIXED DOUBLES</span><input type="number" min="0" max="12" value={formatDraft.mixedDoubles} onChange={(event) => setFormatDraft((current) => ({ ...current, mixedDoubles: Number(event.target.value) }))}/></label>
              </div>
              <div className="format-summary">
                <article><span>Meet size</span><strong>{formatTotal}</strong><small>events</small></article>
                <article><span>Outright win</span><strong>{formatWinsNeeded}</strong><small>wins</small></article>
                <article><span>Roster needed</span><strong>{formatRequiredBoys} + {formatRequiredGirls}</strong><small>boys + girls</small></article>
                <button className="primary-button" disabled={savingFormat || formatTotal < 1 || formatTotal > 50} onClick={() => void saveFormat()}>{savingFormat ? "Saving…" : `Save ${formatDraft.season} Format`}</button>
              </div>
              {formatTotal % 2 === 0 && <p className="format-warning">An even number of events can produce a tied meet. The displayed meet-win probability measures an outright win of at least {formatWinsNeeded} events.</p>}
              <div className="saved-formats"><span>SAVED OR ACTIVE SEASONS</span>{data.seasonFormats.map((format) => <button key={format.season} type="button" onClick={() => chooseFormatSeason(format.season)} className={formatDraft.season === format.season ? "active" : ""}>{format.season} · {format.totalEvents} events{format.configured ? "" : " (default)"}</button>)}</div>
            </section>
            <section className="panel import-panel">
              <div className="upload-mark"><Icon name="upload"/></div><p className="eyebrow">SEASON ROSTER DATA</p><h2>Import season rosters</h2><p>Returning players are recognized by their stable player ID, even when their anonymous rank label changes. At each new season, they keep the higher of carried Elo and their new rank-based initialized Elo. Set active to 0 for historical or ineligible players.</p><button className="primary-button" disabled={importing !== null} onClick={() => rosterInput.current?.click()}>{importing === "roster" ? "Importing…" : "Choose roster CSV"}</button><button className="text-button" onClick={() => downloadTemplate("roster_template.csv", rosterTemplate)}>Download roster template</button>
            </section>
            <section className="panel import-panel">
              <div className="upload-mark"><Icon name="data"/></div><p className="eyebrow">HISTORICAL MATCH DATA</p><h2>Import historical matches</h2><p>Upload every event score from the available years. Each row is checked against that season’s saved format. Duplicate events are ignored, ratings are replayed chronologically, and opponent positional Elo is rebuilt automatically.</p><button className="primary-button" disabled={importing !== null} onClick={() => matchInput.current?.click()}>{importing === "matches" ? "Recalculating…" : "Choose match CSV"}</button><button className="text-button" onClick={() => downloadTemplate("match_history_template.csv", matchTemplate(data))}>Download current-format template</button>
            </section>
            <section className="panel weighting-panel">
              <div className="panel-heading"><div><p className="eyebrow">ROLLING RECENCY WEIGHTING</p><h2>Ten-season window</h2></div><span className="formula">w = 1, 2, …, 10</span></div>
              <p>Only the latest ten recorded seasons affect opponent positional Elo. They are ordered from oldest to newest and assigned weights 1 through 10. When a new season is added, the oldest season leaves the window and every remaining weight is reassigned automatically.</p>
              <div className="weight-timeline">{data.yearWeights.length ? data.yearWeights.map((item) => <div key={item.year}><span>{item.year}</span><strong>{item.weight}</strong><small>weight</small></div>) : Array.from({ length: 10 }, (_, index) => index + 1).map((weight) => <div className="placeholder-weight" key={weight}><span>Year {weight}</span><strong>{weight}</strong><small>weight</small></div>)}</div>
              <div className="rule-grid"><article><strong>Opponent positions</strong><p>Every new result is blended into the position’s cumulative weighted rating.</p></article><article><strong>Returning players</strong><p>Season-start Elo is the higher of carried Elo and the new rank initializer.</p></article><article><strong>New players</strong><p>First-time players receive the preseason rank-curve initialization.</p></article></div>
            </section>
            <section className="panel rating-panel">
              <div className="panel-heading"><div><p className="eyebrow">STABILITY + HISTORICAL CALIBRATION</p><h2>Grounded rating updates</h2></div><span className="formula">ΔE = 2 × |PD| × (A − P)</span></div>
              <p>Home-player Elo now uses K = 2, sharply reducing movement from a single event. Doubles partners split the event adjustment equally. Each opponent receives a school-level correction so its historical predictions match the recorded results closely. The final optimized score is then placed halfway between the historical average and the unrestricted model estimate, preventing unsupported jumps while still allowing lineup improvement.</p>
            </section>
          </div>
        )}
        <input ref={rosterInput} hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file, "roster"); event.target.value = ""; }}/>
        <input ref={matchInput} hidden type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file, "matches"); event.target.value = ""; }}/>
      </main>
    </div>
  );
}
