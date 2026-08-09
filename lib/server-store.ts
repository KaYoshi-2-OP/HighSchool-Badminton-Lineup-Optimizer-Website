import { env } from "cloudflare:workers";
import {
  EVENT_ORDER,
  type EventCode,
  type PlayerRecord,
  type PositionRating,
  defaultPositionElo,
  eloWinProbability,
  fitOpponentEloOffset,
  homePlayerEloChange,
  isEventCode,
  normalizeGender,
  normalizeName,
  preseasonElo,
  schoolIdFromName,
  smoothedHistoricalWins,
} from "./domain";

const POINT_SCALE = 8;
const POSITION_SEASON_WINDOW = 10;
const RATING_MODEL_VERSION = "home-k2-fixed-home-calibrated-v3";

type CsvRow = Record<string, string | number | null | undefined>;

type DbPlayer = {
  id: string;
  school_id: string;
  player_code: string;
  display_name: string;
  gender: string;
  rank: number;
  initial_elo: number;
  current_elo: number;
  first_season: number;
  last_season: number;
  active: number;
};

type DbPosition = {
  position: string;
  current_elo: number;
  total_weight: number;
  matches_used: number;
};

type DbCalibration = {
  elo_offset: number;
  actual_wins: number;
  projected_wins: number;
  event_count: number;
  meet_count: number;
};

function db() {
  if (!env.DB) throw new Error("Persistent database binding is unavailable.");
  return env.DB;
}

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  await db().batch([
    db().prepare(`CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS schools_name_unique ON schools (name)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY NOT NULL,
      school_id TEXT NOT NULL,
      player_code TEXT NOT NULL,
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      gender TEXT NOT NULL,
      rank INTEGER NOT NULL,
      initial_elo REAL NOT NULL,
      current_elo REAL NOT NULL,
      first_season INTEGER NOT NULL,
      last_season INTEGER NOT NULL,
      active INTEGER DEFAULT 1 NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS players_school_code_unique ON players (school_id, player_code)"),
    db().prepare("CREATE INDEX IF NOT EXISTS players_school_active_idx ON players (school_id, active)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS player_aliases (
      id TEXT PRIMARY KEY NOT NULL,
      school_id TEXT NOT NULL,
      alias_code TEXT NOT NULL,
      player_id TEXT NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS player_alias_school_code_unique ON player_aliases (school_id, alias_code)"),
    db().prepare("CREATE INDEX IF NOT EXISTS player_alias_player_idx ON player_aliases (player_id)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS match_events (
      id TEXT PRIMARY KEY NOT NULL,
      match_date TEXT NOT NULL,
      season_year INTEGER NOT NULL,
      season_weight INTEGER DEFAULT 1 NOT NULL,
      home_school_id TEXT NOT NULL,
      opponent_school_id TEXT NOT NULL,
      position TEXT NOT NULL,
      home_player_1_code TEXT NOT NULL,
      home_player_2_code TEXT,
      scores_json TEXT NOT NULL,
      point_differential INTEGER NOT NULL,
      home_won INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS match_event_unique ON match_events (home_school_id, opponent_school_id, match_date, position)"),
    db().prepare("CREATE INDEX IF NOT EXISTS match_events_home_date_idx ON match_events (home_school_id, match_date)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS opponent_positions (
      id TEXT PRIMARY KEY NOT NULL,
      home_school_id TEXT NOT NULL,
      opponent_school_id TEXT NOT NULL,
      position TEXT NOT NULL,
      current_elo REAL NOT NULL,
      total_weight REAL NOT NULL,
      matches_used INTEGER NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS opponent_position_unique ON opponent_positions (home_school_id, opponent_school_id, position)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS model_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    )`),
    db().prepare(`CREATE TABLE IF NOT EXISTS player_seasons (
      id TEXT PRIMARY KEY NOT NULL,
      player_id TEXT NOT NULL,
      school_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      initialized_elo REAL NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS player_season_unique ON player_seasons (player_id, season)"),
    db().prepare("CREATE INDEX IF NOT EXISTS player_seasons_school_season_idx ON player_seasons (school_id, season)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS opponent_calibrations (
      id TEXT PRIMARY KEY NOT NULL,
      home_school_id TEXT NOT NULL,
      opponent_school_id TEXT NOT NULL,
      elo_offset REAL NOT NULL,
      actual_wins REAL NOT NULL,
      projected_wins REAL NOT NULL,
      event_count INTEGER NOT NULL,
      meet_count INTEGER NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS opponent_calibration_unique ON opponent_calibrations (home_school_id, opponent_school_id)"),
    db().prepare(
      `INSERT OR IGNORE INTO player_seasons
       (id, player_id, school_id, season, rank, initialized_elo)
       SELECT id || ':' || last_season, id, school_id, last_season, rank, initial_elo FROM players`,
    ),
  ]);
  schemaReady = true;
}

function text(row: CsvRow, key: string): string {
  return String(row[key] ?? "").trim();
}

function integer(row: CsvRow, key: string): number {
  const value = Number(text(row, key));
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer.`);
  return value;
}

function mapPlayer(row: DbPlayer): PlayerRecord {
  return {
    id: row.id,
    schoolId: row.school_id,
    playerCode: row.player_code,
    displayName: row.display_name,
    gender: normalizeGender(row.gender),
    rank: Number(row.rank),
    initialElo: Number(row.initial_elo),
    currentElo: Number(row.current_elo),
    firstSeason: Number(row.first_season),
    lastSeason: Number(row.last_season),
    active: Boolean(row.active),
  };
}

async function ensureSchool(name: string): Promise<string> {
  const schoolName = name.trim();
  const id = schoolIdFromName(schoolName);
  await db()
    .prepare("INSERT OR IGNORE INTO schools (id, name) VALUES (?, ?)")
    .bind(id, schoolName)
    .run();
  return id;
}

async function readHomeSchoolId(): Promise<string | null> {
  const stored = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = 'home_school_id'",
  ).first<{ value: string }>();
  if (stored?.value) return stored.value;

  const rosterLeader = await db().prepare(
    `SELECT school_id AS id, COUNT(*) AS count FROM players
     GROUP BY school_id ORDER BY count DESC LIMIT 1`,
  ).first<{ id: string; count: number }>();
  if (!rosterLeader?.id) return null;
  if (rosterLeader.id !== "north-valley-high") {
    const demoMatches = await db().prepare(
      "SELECT COUNT(*) AS count FROM match_events WHERE home_school_id = 'north-valley-high'",
    ).first<{ count: number }>();
    if (Number(demoMatches?.count ?? 0) === 0) {
      await db().batch([
        db().prepare("DELETE FROM player_seasons WHERE school_id = 'north-valley-high'"),
        db().prepare("DELETE FROM player_aliases WHERE school_id = 'north-valley-high'"),
        db().prepare("DELETE FROM players WHERE school_id = 'north-valley-high'"),
        db().prepare("DELETE FROM opponent_positions WHERE home_school_id = 'north-valley-high'"),
        db().prepare("DELETE FROM opponent_calibrations WHERE home_school_id = 'north-valley-high'"),
        db().prepare("DELETE FROM schools WHERE id IN ('north-valley-high', 'east-ridge-high')"),
      ]);
    }
  }
  await db().prepare(
    "INSERT INTO model_metadata (key, value) VALUES ('home_school_id', ?)",
  ).bind(rosterLeader.id).run();
  return rosterLeader.id;
}

async function lockHomeSchool(schoolId: string) {
  let current = await readHomeSchoolId();
  const demoSeed = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = 'demo_seeded'",
  ).first<{ value: string }>();
  if (current === "north-valley-high" && schoolId !== current && demoSeed?.value === "1") {
    await db().batch([
      db().prepare("DELETE FROM player_seasons WHERE school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM player_aliases WHERE school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM players WHERE school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM match_events WHERE home_school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM opponent_positions WHERE home_school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM opponent_calibrations WHERE home_school_id = 'north-valley-high'"),
      db().prepare("DELETE FROM schools WHERE id IN ('north-valley-high', 'east-ridge-high')"),
      db().prepare("DELETE FROM model_metadata WHERE key IN ('home_school_id', 'demo_seeded', 'rating_model_version')"),
    ]);
    current = null;
  }
  if (current && current !== schoolId) {
    throw new Error("This site is already locked to a different home school.");
  }
  if (!current) {
    await db().prepare(
      "INSERT INTO model_metadata (key, value) VALUES ('home_school_id', ?)",
    ).bind(schoolId).run();
  }
}

export async function ensureDemoData() {
  await ensureSchema();
  const existing = await db().prepare("SELECT COUNT(*) AS count FROM schools").first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return;

  const homeId = "north-valley-high";
  const opponentId = "east-ridge-high";
  const statements = [
    db().prepare("INSERT INTO schools (id, name) VALUES (?, ?)").bind(homeId, "North Valley High"),
    db().prepare("INSERT INTO schools (id, name) VALUES (?, ?)").bind(opponentId, "East Ridge High"),
    db().prepare("INSERT INTO model_metadata (key, value) VALUES ('home_school_id', ?)").bind(homeId),
    db().prepare("INSERT INTO model_metadata (key, value) VALUES ('demo_seeded', '1')"),
  ];

  for (const [gender, prefix] of [["Boys", "B"], ["Girls", "G"]] as const) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const code = `${prefix}${rank}`;
      const id = `${homeId}:${code.toLowerCase()}`;
      const rating = preseasonElo(rank, 13);
      statements.push(
        db().prepare(
          `INSERT INTO players
           (id, school_id, player_code, display_name, normalized_name, gender, rank,
            initial_elo, current_elo, first_season, last_season, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2026, 2026, 1)`,
        ).bind(id, homeId, code, `Player ${code}`, normalizeName(`Player ${code}`), gender, rank, rating, rating),
        db().prepare(
          "INSERT INTO player_aliases (id, school_id, alias_code, player_id) VALUES (?, ?, ?, ?)",
        ).bind(`${homeId}:${code.toLowerCase()}`, homeId, code.toLowerCase(), id),
      );
    }
  }

  for (const position of EVENT_ORDER) {
    const number = Number(position.at(-1));
    const rating = position.startsWith("BS") || position.startsWith("GS")
      ? 2140 - number * 120
      : 3600 - number * 140;
    statements.push(
      db().prepare(
        `INSERT INTO opponent_positions
         (id, home_school_id, opponent_school_id, position, current_elo, total_weight, matches_used)
         VALUES (?, ?, ?, ?, ?, 6, 3)`,
      ).bind(`${homeId}|${opponentId}|${position}`, homeId, opponentId, position, rating),
    );
  }
  await db().batch(statements);
}

export async function getDashboard(opponentSchoolId?: string) {
  await ensureDemoData();
  await ensureCurrentRatingModel();
  const homeSchoolId = await readHomeSchoolId();
  const schoolRows = await db().prepare("SELECT id, name FROM schools ORDER BY name").all<{ id: string; name: string }>();
  const schools = schoolRows.results;
  const selectedHome = schools.find((school) => school.id === homeSchoolId) ?? schools[0];
  const selectedOpponent = schools.find((school) => school.id === opponentSchoolId && school.id !== selectedHome.id)
    ?? schools.find((school) => school.id !== selectedHome.id)
    ?? null;

  const playerRows = await db().prepare(
    "SELECT * FROM players WHERE school_id = ? ORDER BY gender, rank, display_name",
  ).bind(selectedHome.id).all<DbPlayer>();

  let positions: PositionRating[] = [];
  let historicalFit: {
    actualWinsPerMeet: number;
    projectedWinsPerMeet: number;
    meetCount: number;
    eloOffset: number;
  } | null = null;
  if (selectedOpponent) {
    const positionRows = await db().prepare(
      `SELECT position, current_elo, total_weight, matches_used
       FROM opponent_positions
       WHERE home_school_id = ? AND opponent_school_id = ?`,
    ).bind(selectedHome.id, selectedOpponent.id).all<DbPosition>();
    const calibration = await db().prepare(
      `SELECT elo_offset, actual_wins, projected_wins, event_count, meet_count
       FROM opponent_calibrations
       WHERE home_school_id = ? AND opponent_school_id = ?`,
    ).bind(selectedHome.id, selectedOpponent.id).first<DbCalibration>();
    const offset = Number(calibration?.elo_offset ?? 0);
    const byEvent = new Map(positionRows.results.map((row) => [row.position, row]));
    positions = EVENT_ORDER.map((position) => {
      const row = byEvent.get(position);
      return {
        position,
        currentElo: Number(row?.current_elo ?? defaultPositionElo(position)) + offset,
        totalWeight: Number(row?.total_weight ?? 0),
        matchesUsed: Number(row?.matches_used ?? 0),
      };
    });
    if (calibration && Number(calibration.meet_count) > 0) {
      historicalFit = {
        actualWinsPerMeet: Number(calibration.actual_wins) / Number(calibration.meet_count),
        projectedWinsPerMeet: Number(calibration.projected_wins) / Number(calibration.meet_count),
        meetCount: Number(calibration.meet_count),
        eloOffset: offset,
      };
    }
  }

  const yearRows = await db().prepare(
    `SELECT season_year AS year, MAX(season_weight) AS weight
     FROM match_events WHERE home_school_id = ? AND season_weight > 0
     GROUP BY season_year ORDER BY season_year`,
  ).bind(selectedHome.id).all<{ year: number; weight: number }>();
  const matchCount = await db().prepare(
    "SELECT COUNT(*) AS count FROM match_events WHERE home_school_id = ?",
  ).bind(selectedHome.id).first<{ count: number }>();

  const players = playerRows.results.map(mapPlayer);
  return {
    schools,
    selectedHome,
    selectedOpponent,
    homeLocked: true,
    players,
    positions,
    yearWeights: yearRows.results.map((row) => ({ year: Number(row.year), weight: Number(row.weight) })),
    matchCount: Number(matchCount?.count ?? 0),
    returningPlayers: players.filter((player) => player.firstSeason < player.lastSeason).length,
    historicalFit,
    demo: selectedHome.id === "north-valley-high",
  };
}

async function findPlayer(schoolId: string, code: string, name?: string) {
  const normalizedCode = code.trim().toLowerCase();
  const byAlias = normalizedCode
    ? await db().prepare(
        `SELECT p.* FROM player_aliases a
         JOIN players p ON p.id = a.player_id
         WHERE a.school_id = ? AND a.alias_code = ?`,
      ).bind(schoolId, normalizedCode).first<DbPlayer>()
    : null;
  if (byAlias) return byAlias;
  const normalized = normalizeName(name ?? "");
  if (!normalized) return null;
  return db().prepare(
    "SELECT * FROM players WHERE school_id = ? AND normalized_name = ? LIMIT 1",
  ).bind(schoolId, normalized).first<DbPlayer>();
}

export async function importRosters(rows: CsvRow[]) {
  await ensureSchema();
  if (!rows.length) throw new Error("The roster CSV contains no data rows.");
  const prepared = [] as Array<{
    schoolName: string;
    schoolId: string;
    season: number;
    code: string;
    name: string;
    gender: "Boys" | "Girls";
    rank: number;
    active: boolean;
    ladderSize: number | null;
  }>;

  for (const [index, row] of rows.entries()) {
    const schoolName = text(row, "school");
    const season = integer(row, "season");
    const code = text(row, "player_id");
    const name = text(row, "name");
    const rank = integer(row, "rank");
    const ladderSizeText = text(row, "ladder_size");
    const ladderSize = ladderSizeText ? Number(ladderSizeText) : null;
    if (!schoolName || !code || !name || season < 1900 || rank < 1) {
      throw new Error(`Roster row ${index + 2} is incomplete or invalid.`);
    }
    if (ladderSize !== null && (!Number.isInteger(ladderSize) || ladderSize < rank)) {
      throw new Error(`Roster row ${index + 2}: ladder_size must be an integer at least as large as rank.`);
    }
    prepared.push({
      schoolName,
      schoolId: schoolIdFromName(schoolName),
      season,
      code,
      name,
      gender: normalizeGender(text(row, "gender")),
      rank,
      active: !["0", "false", "no", "inactive"].includes(text(row, "active").toLowerCase()),
      ladderSize,
    });
  }

  const requestedSchools = [...new Set(prepared.map((row) => row.schoolId))];
  if (requestedSchools.length !== 1) {
    throw new Error("A roster file must contain exactly one home school.");
  }
  await lockHomeSchool(requestedSchools[0]);
  await ensureSchool(prepared[0].schoolName);

  let created = 0;
  let continued = 0;
  const schoolIds = [...new Set(prepared.map((row) => row.schoolId))];
  for (const schoolId of schoolIds) {
    const schoolRows = prepared.filter((row) => row.schoolId === schoolId);
    const latestImportSeason = Math.max(...schoolRows.map((row) => row.season));
    const existingLatest = await db().prepare(
      "SELECT MAX(last_season) AS season FROM players WHERE school_id = ?",
    ).bind(schoolId).first<{ season: number | null }>();
    const changesActiveRoster = latestImportSeason >= Number(existingLatest?.season ?? 0);
    if (changesActiveRoster) {
      await db().prepare("UPDATE players SET active = 0 WHERE school_id = ?").bind(schoolId).run();
    }

    const groupSizes = new Map<string, number>();
    for (const row of schoolRows) {
      const key = `${row.season}:${row.gender}`;
      groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
    }

    for (const row of schoolRows.sort((a, b) => a.season - b.season || a.rank - b.rank)) {
      const existing = await findPlayer(schoolId, row.code);
      const isActive = changesActiveRoster && row.season === latestImportSeason
        ? Number(row.active)
        : Number(existing?.active ?? 0);
      const size = row.ladderSize ?? groupSizes.get(`${row.season}:${row.gender}`) ?? 1;
      const initializedElo = preseasonElo(row.rank, size);
      if (existing) {
        continued += 1;
        const isEarlierSeason = row.season < Number(existing.first_season);
        const appliesToCurrentElo = row.season >= Number(existing.last_season);
        await db().prepare(
          `UPDATE players SET display_name = ?, normalized_name = ?, gender = ?, rank = ?,
           initial_elo = CASE WHEN ? THEN ? ELSE initial_elo END,
           current_elo = CASE WHEN ? AND current_elo < ? THEN ? ELSE current_elo END,
           first_season = MIN(first_season, ?), last_season = MAX(last_season, ?), active = ?
           WHERE id = ?`,
        ).bind(
          row.name,
          normalizeName(row.name),
          row.gender,
          row.rank,
          Number(isEarlierSeason),
          initializedElo,
          Number(appliesToCurrentElo),
          initializedElo,
          initializedElo,
          row.season,
          row.season,
          isActive,
          existing.id,
        ).run();
        await db().batch([
          db().prepare(
            "INSERT OR IGNORE INTO player_aliases (id, school_id, alias_code, player_id) VALUES (?, ?, ?, ?)",
          ).bind(`${schoolId}:${row.code.toLowerCase()}`, schoolId, row.code.toLowerCase(), existing.id),
          db().prepare(
            `INSERT INTO player_seasons (id, player_id, school_id, season, rank, initialized_elo)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(player_id, season) DO UPDATE SET
               rank = excluded.rank, initialized_elo = excluded.initialized_elo`,
          ).bind(`${existing.id}:${row.season}`, existing.id, schoolId, row.season, row.rank, initializedElo),
        ]);
      } else {
        created += 1;
        const playerId = `${schoolId}:${row.code.toLowerCase()}`;
        await db().batch([
          db().prepare(
            `INSERT INTO players
             (id, school_id, player_code, display_name, normalized_name, gender, rank,
              initial_elo, current_elo, first_season, last_season, active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(playerId, schoolId, row.code, row.name, normalizeName(row.name), row.gender, row.rank, initializedElo, initializedElo, row.season, row.season, isActive),
          db().prepare(
            "INSERT INTO player_aliases (id, school_id, alias_code, player_id) VALUES (?, ?, ?, ?)",
          ).bind(`${schoolId}:${row.code.toLowerCase()}`, schoolId, row.code.toLowerCase(), playerId),
          db().prepare(
            `INSERT INTO player_seasons (id, player_id, school_id, season, rank, initialized_elo)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(`${playerId}:${row.season}`, playerId, schoolId, row.season, row.rank, initializedElo),
        ]);
      }
    }
  }

  return { created, continued, schools: schoolIds.length };
}

type ParsedMatch = {
  date: string;
  year: number;
  homeSchoolId: string;
  opponentSchoolId: string;
  position: EventCode;
  player1: string;
  player2: string | null;
  games: Array<[number, number]>;
  pointDifferential: number;
  homeWon: boolean;
};

type RatingSnapshot = {
  players: Map<string, { code: string; name: string; elo: number }>;
  positions: Map<EventCode, number>;
};

export type MeetRatingReceipt = {
  exact: boolean;
  date: string;
  homeSchool: string;
  opponentSchool: string;
  homeWins: number;
  homeLosses: number;
  playerChanges: Array<{
    code: string;
    name: string;
    oldElo: number;
    change: number;
    newElo: number;
  }>;
  positionChanges: Array<{
    position: EventCode;
    oldElo: number;
    change: number;
    newElo: number;
  }>;
};

function parseGames(row: CsvRow): Array<[number, number]> {
  const games: Array<[number, number]> = [];
  for (let game = 1; game <= 3; game += 1) {
    const homeText = text(row, `g${game}_home`);
    const opponentText = text(row, `g${game}_opponent`);
    if (!homeText && !opponentText) continue;
    const home = Number(homeText);
    const opponent = Number(opponentText);
    if (!Number.isInteger(home) || !Number.isInteger(opponent) || home < 0 || opponent < 0 || home === opponent) {
      throw new Error(`Game ${game} contains an invalid score.`);
    }
    games.push([home, opponent]);
  }
  const wins = games.filter(([home, opponent]) => home > opponent).length;
  const losses = games.length - wins;
  if (!((games.length === 2 && (wins === 2 || losses === 2)) || (games.length === 3 && (wins === 2 || losses === 2)))) {
    throw new Error("Scores must form a completed best-of-three match.");
  }
  return games;
}

async function parseMatchRows(rows: CsvRow[], createOpponentSchools: boolean) {
  if (!rows.length) throw new Error("The match data contains no event rows.");
  const lockedHomeSchoolId = await readHomeSchoolId();
  if (!lockedHomeSchoolId) throw new Error("Import the home-school roster before importing matches.");
  const parsed: ParsedMatch[] = [];
  for (const [index, row] of rows.entries()) {
    const date = text(row, "date");
    const matchDate = new Date(`${date}T00:00:00Z`);
    const positionText = text(row, "position").toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(matchDate.valueOf())) {
      throw new Error(`Match row ${index + 2}: date must use YYYY-MM-DD.`);
    }
    if (!isEventCode(positionText)) throw new Error(`Match row ${index + 2}: invalid position.`);
    const homeName = text(row, "home_school");
    const opponentName = text(row, "opponent_school");
    const player1 = text(row, "home_player_1");
    const player2Text = text(row, "home_player_2");
    const needsPair = positionText.startsWith("BD") || positionText.startsWith("GD") || positionText.startsWith("XD");
    if (!homeName || !opponentName || !player1 || (needsPair && !player2Text)) {
      throw new Error(`Match row ${index + 2} is missing a required value.`);
    }
    const homeSchoolId = schoolIdFromName(homeName);
    if (homeSchoolId !== lockedHomeSchoolId) {
      throw new Error(`Match row ${index + 2}: home_school must match this site's locked home school.`);
    }
    const requestedOpponentId = schoolIdFromName(opponentName);
    const opponentSchoolId = createOpponentSchools
      ? await ensureSchool(opponentName)
      : (await db().prepare("SELECT id FROM schools WHERE id = ?").bind(requestedOpponentId).first<{ id: string }>())?.id;
    if (!opponentSchoolId) {
      throw new Error(`Match row ${index + 2}: the selected opponent is not in the database.`);
    }
    if (homeSchoolId === opponentSchoolId) throw new Error(`Match row ${index + 2}: schools must be different.`);
    const firstPlayer = await findPlayer(homeSchoolId, player1);
    const secondPlayer = player2Text ? await findPlayer(homeSchoolId, player2Text) : null;
    if (!firstPlayer || (needsPair && !secondPlayer)) {
      throw new Error(`Match row ${index + 2}: import the home roster before its matches.`);
    }
    const games = parseGames(row);
    const wins = games.filter(([home, opponent]) => home > opponent).length;
    parsed.push({
      date,
      year: matchDate.getUTCFullYear(),
      homeSchoolId,
      opponentSchoolId,
      position: positionText,
      player1: firstPlayer.player_code,
      player2: secondPlayer?.player_code ?? null,
      games,
      pointDifferential: games.reduce((sum, [home, opponent]) => sum + home - opponent, 0),
      homeWon: wins === 2,
    });
  }

  return parsed;
}

async function validateCompleteMeet(parsed: ParsedMatch[]) {
  if (parsed.length !== EVENT_ORDER.length) {
    throw new Error(`A complete meet requires exactly ${EVENT_ORDER.length} event results.`);
  }
  const first = parsed[0];
  if (parsed.some((match) => match.date !== first.date
    || match.homeSchoolId !== first.homeSchoolId
    || match.opponentSchoolId !== first.opponentSchoolId)) {
    throw new Error("Every event must use the same date, home school, and opponent school.");
  }
  const positions = new Set(parsed.map((match) => match.position));
  if (positions.size !== EVENT_ORDER.length || EVENT_ORDER.some((position) => !positions.has(position))) {
    throw new Error("The meet must contain each of the 17 positions exactly once.");
  }

  const usedPlayers = new Set<string>();
  for (const match of parsed) {
    const firstPlayer = await findPlayer(match.homeSchoolId, match.player1);
    const secondPlayer = match.player2 ? await findPlayer(match.homeSchoolId, match.player2) : null;
    if (!firstPlayer || (match.player2 && !secondPlayer)) throw new Error(`Could not resolve the players entered for ${match.position}.`);
    const pairEvent = match.position.startsWith("BD") || match.position.startsWith("GD") || match.position.startsWith("XD");
    if (!pairEvent && secondPlayer) throw new Error(`${match.position} is a singles event and must have only one player.`);
    const expectedFirstGender = match.position.startsWith("GS") || match.position.startsWith("GD") ? "Girls" : "Boys";
    const expectedSecondGender = match.position.startsWith("GD") || match.position.startsWith("XD") ? "Girls" : "Boys";
    if (firstPlayer.gender !== expectedFirstGender) throw new Error(`${firstPlayer.display_name} is not eligible for ${match.position}.`);
    if (secondPlayer && secondPlayer.gender !== expectedSecondGender) throw new Error(`${secondPlayer.display_name} is not eligible for ${match.position}.`);
    for (const player of [firstPlayer, secondPlayer]) {
      if (!player) continue;
      if (usedPlayers.has(player.id)) throw new Error(`${player.display_name} appears more than once in the meet.`);
      usedPlayers.add(player.id);
    }
  }

  const existing = await db().prepare(
    `SELECT COUNT(*) AS count FROM match_events
     WHERE home_school_id = ? AND opponent_school_id = ? AND match_date = ?`,
  ).bind(first.homeSchoolId, first.opponentSchoolId, first.date).first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) {
    throw new Error("Results for this opponent and date already exist. Change the date or use a different opponent.");
  }
}

async function ratingSnapshot(parsed: ParsedMatch[]): Promise<RatingSnapshot> {
  const first = parsed[0];
  const uniqueCodes = [...new Set(parsed.flatMap((match) => [match.player1, match.player2].filter(Boolean) as string[]))];
  const playerMap = new Map<string, { code: string; name: string; elo: number }>();
  for (const code of uniqueCodes) {
    const player = await findPlayer(first.homeSchoolId, code);
    if (!player) throw new Error(`Could not find player ${code}.`);
    playerMap.set(player.player_code.toLowerCase(), {
      code: player.player_code,
      name: player.display_name,
      elo: Number(player.current_elo),
    });
  }

  const rows = await db().prepare(
    `SELECT position, current_elo FROM opponent_positions
     WHERE home_school_id = ? AND opponent_school_id = ?`,
  ).bind(first.homeSchoolId, first.opponentSchoolId).all<{ position: EventCode; current_elo: number }>();
  const calibration = await db().prepare(
    `SELECT elo_offset FROM opponent_calibrations
     WHERE home_school_id = ? AND opponent_school_id = ?`,
  ).bind(first.homeSchoolId, first.opponentSchoolId).first<{ elo_offset: number }>();
  const offset = Number(calibration?.elo_offset ?? 0);
  const raw = new Map(rows.results.map((row) => [row.position, Number(row.current_elo)]));
  return {
    players: playerMap,
    positions: new Map(EVENT_ORDER.map((position) => [
      position,
      (raw.get(position) ?? defaultPositionElo(position)) + offset,
    ])),
  };
}

async function receiptFromSnapshots(
  parsed: ParsedMatch[],
  before: RatingSnapshot,
  after: RatingSnapshot,
  exact: boolean,
): Promise<MeetRatingReceipt> {
  const first = parsed[0];
  const schoolRows = await db().prepare("SELECT id, name FROM schools WHERE id IN (?, ?)")
    .bind(first.homeSchoolId, first.opponentSchoolId).all<{ id: string; name: string }>();
  const names = new Map(schoolRows.results.map((row) => [row.id, row.name]));
  const playerOrder = [...new Set(parsed.flatMap((match) => [match.player1, match.player2].filter(Boolean) as string[]))];
  return {
    exact,
    date: first.date,
    homeSchool: names.get(first.homeSchoolId) ?? first.homeSchoolId,
    opponentSchool: names.get(first.opponentSchoolId) ?? first.opponentSchoolId,
    homeWins: parsed.filter((match) => match.homeWon).length,
    homeLosses: parsed.filter((match) => !match.homeWon).length,
    playerChanges: playerOrder.map((code) => {
      const oldPlayer = before.players.get(code.toLowerCase());
      const newPlayer = after.players.get(code.toLowerCase());
      if (!oldPlayer || !newPlayer) throw new Error(`Could not calculate a rating receipt for ${code}.`);
      return {
        code: oldPlayer.code,
        name: oldPlayer.name,
        oldElo: oldPlayer.elo,
        change: newPlayer.elo - oldPlayer.elo,
        newElo: newPlayer.elo,
      };
    }),
    positionChanges: EVENT_ORDER.map((position) => {
      const oldElo = before.positions.get(position) ?? defaultPositionElo(position);
      const newElo = after.positions.get(position) ?? defaultPositionElo(position);
      return { position, oldElo, change: newElo - oldElo, newElo };
    }),
  };
}

async function estimatedMeetReceipt(parsed: ParsedMatch[]) {
  const before = await ratingSnapshot(parsed);
  const after: RatingSnapshot = {
    players: new Map([...before.players].map(([code, player]) => [code, { ...player }])),
    positions: new Map(before.positions),
  };
  const first = parsed[0];
  const yearRows = await db().prepare(
    "SELECT DISTINCT season_year AS year FROM match_events WHERE home_school_id = ? ORDER BY season_year",
  ).bind(first.homeSchoolId).all<{ year: number }>();
  const activeYears = [...new Set([...yearRows.results.map((row) => Number(row.year)), first.year])]
    .sort((a, b) => a - b).slice(-POSITION_SEASON_WINDOW);
  const yearWeight = Math.max(1, activeYears.indexOf(first.year) + 1);
  const positionRows = await db().prepare(
    `SELECT position, current_elo, total_weight FROM opponent_positions
     WHERE home_school_id = ? AND opponent_school_id = ?`,
  ).bind(first.homeSchoolId, first.opponentSchoolId).all<{ position: EventCode; current_elo: number; total_weight: number }>();
  const calibration = await db().prepare(
    `SELECT elo_offset FROM opponent_calibrations
     WHERE home_school_id = ? AND opponent_school_id = ?`,
  ).bind(first.homeSchoolId, first.opponentSchoolId).first<{ elo_offset: number }>();
  const offset = Number(calibration?.elo_offset ?? 0);
  const positionState = new Map(positionRows.results.map((row) => [row.position, {
    elo: Number(row.current_elo),
    weight: Number(row.total_weight),
  }]));

  for (const match of parsed) {
    const player1 = after.players.get(match.player1.toLowerCase());
    const player2 = match.player2 ? after.players.get(match.player2.toLowerCase()) : null;
    if (!player1 || (match.player2 && !player2)) throw new Error(`Could not calculate ${match.position}.`);
    const homeElo = player1.elo + (player2?.elo ?? 0);
    const prior = positionState.get(match.position);
    const observation = homeElo - POINT_SCALE * match.pointDifferential;
    const rawOpponentElo = prior?.elo ?? observation;
    const expected = eloWinProbability(homeElo, rawOpponentElo);
    const eventChange = homePlayerEloChange(match.pointDifferential, match.homeWon ? 1 : 0, expected);
    const playerChange = eventChange / (player2 ? 2 : 1);
    player1.elo += playerChange;
    if (player2) player2.elo += playerChange;
    const priorWeight = prior?.weight ?? 0;
    const newWeight = priorWeight + yearWeight;
    const nextRaw = priorWeight > 0
      ? (rawOpponentElo * priorWeight + observation * yearWeight) / newWeight
      : observation;
    after.positions.set(match.position, nextRaw + offset);
  }
  return receiptFromSnapshots(parsed, before, after, false);
}

export async function previewMeet(rows: CsvRow[]) {
  await ensureSchema();
  await ensureCurrentRatingModel();
  const parsed = await parseMatchRows(rows, false);
  await validateCompleteMeet(parsed);
  return estimatedMeetReceipt(parsed);
}

export async function confirmMeet(rows: CsvRow[]) {
  await ensureSchema();
  await ensureCurrentRatingModel();
  const parsed = await parseMatchRows(rows, false);
  await validateCompleteMeet(parsed);
  const before = await ratingSnapshot(parsed);
  const imported = await importMatches(rows);
  if (imported.inserted !== EVENT_ORDER.length) {
    throw new Error("The complete meet could not be saved. No duplicate events are allowed.");
  }
  const after = await ratingSnapshot(parsed);
  return { ...imported, receipt: await receiptFromSnapshots(parsed, before, after, true) };
}

export async function importMatches(rows: CsvRow[]) {
  await ensureSchema();
  const parsed = await parseMatchRows(rows, true);

  let inserted = 0;
  let duplicates = 0;
  for (const match of parsed) {
    const id = `${match.homeSchoolId}|${match.opponentSchoolId}|${match.date}|${match.position}`;
    const result = await db().prepare(
      `INSERT OR IGNORE INTO match_events
       (id, match_date, season_year, season_weight, home_school_id, opponent_school_id,
        position, home_player_1_code, home_player_2_code, scores_json, point_differential, home_won)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      match.date,
      match.year,
      match.homeSchoolId,
      match.opponentSchoolId,
      match.position,
      match.player1,
      match.player2,
      JSON.stringify(match.games),
      match.pointDifferential,
      match.homeWon ? 1 : 0,
    ).run();
    if (Number(result.meta.changes ?? 0) > 0) inserted += 1;
    else duplicates += 1;
  }

  await recomputeRatings();
  return { inserted, duplicates, yearsReweighted: true };
}

async function recomputeRatings() {
  await db().batch([
    db().prepare("UPDATE players SET current_elo = initial_elo"),
    db().prepare("DELETE FROM opponent_positions"),
    db().prepare("DELETE FROM opponent_calibrations"),
  ]);

  const events = await db().prepare(
    `SELECT * FROM match_events
     ORDER BY match_date, home_school_id, opponent_school_id, position`,
  ).all<{
    id: string;
    match_date: string;
    season_year: number;
    season_weight: number;
    home_school_id: string;
    opponent_school_id: string;
    position: EventCode;
    home_player_1_code: string;
    home_player_2_code: string | null;
    point_differential: number;
    home_won: number;
  }>();

  const playerSeasonRows = await db().prepare(
    `SELECT player_id, school_id, season, initialized_elo
     FROM player_seasons ORDER BY school_id, season, player_id`,
  ).all<{ player_id: string; school_id: string; season: number; initialized_elo: number }>();
  const floorsBySchool = new Map<string, typeof playerSeasonRows.results>();
  for (const row of playerSeasonRows.results) {
    const rows = floorsBySchool.get(row.school_id) ?? [];
    rows.push(row);
    floorsBySchool.set(row.school_id, rows);
  }
  const appliedFloors = new Set<string>();
  const applyFloorsThrough = async (schoolId: string, season: number) => {
    for (const row of floorsBySchool.get(schoolId) ?? []) {
      const key = `${row.player_id}:${row.season}`;
      if (Number(row.season) > season || appliedFloors.has(key)) continue;
      await db().prepare(
        `UPDATE players SET current_elo = CASE
         WHEN current_elo < ? THEN ? ELSE current_elo END WHERE id = ?`,
      ).bind(row.initialized_elo, row.initialized_elo, row.player_id).run();
      appliedFloors.add(key);
    }
  };

  const yearsBySchool = new Map<string, number[]>();
  for (const event of events.results) {
    const years = yearsBySchool.get(event.home_school_id) ?? [];
    if (!years.includes(Number(event.season_year))) years.push(Number(event.season_year));
    yearsBySchool.set(event.home_school_id, years);
  }
  for (const [schoolId, years] of yearsBySchool) {
    years.sort((a, b) => a - b);
    yearsBySchool.set(schoolId, years.slice(-POSITION_SEASON_WINDOW));
  }

  for (const event of events.results) {
    await applyFloorsThrough(event.home_school_id, Number(event.season_year));
    const activeYears = yearsBySchool.get(event.home_school_id) ?? [];
    const activeYearIndex = activeYears.indexOf(Number(event.season_year));
    const yearWeight = activeYearIndex >= 0 ? activeYearIndex + 1 : 0;
    event.season_weight = yearWeight;
    await db().prepare("UPDATE match_events SET season_weight = ? WHERE id = ?").bind(yearWeight, event.id).run();
    const player1 = await findPlayer(event.home_school_id, event.home_player_1_code);
    const player2 = event.home_player_2_code
      ? await findPlayer(event.home_school_id, event.home_player_2_code)
      : null;
    if (!player1 || (event.home_player_2_code && !player2)) continue;

    const homeElo = Number(player1.current_elo) + Number(player2?.current_elo ?? 0);
    const positionId = `${event.home_school_id}|${event.opponent_school_id}|${event.position}`;
    const old = yearWeight > 0
      ? await db().prepare(
          "SELECT current_elo, total_weight, matches_used FROM opponent_positions WHERE id = ?",
        ).bind(positionId).first<{ current_elo: number; total_weight: number; matches_used: number }>()
      : null;
    const observation = homeElo - POINT_SCALE * Number(event.point_differential);
    const oldWeight = Number(old?.total_weight ?? 0);
    const newWeight = oldWeight + yearWeight;
    const newOpponentElo = yearWeight > 0 && oldWeight > 0
      ? (Number(old?.current_elo) * oldWeight + observation * yearWeight) / newWeight
      : observation;
    const expected = eloWinProbability(homeElo, oldWeight > 0 ? Number(old?.current_elo) : observation);
    const margin = Math.abs(Number(event.point_differential));
    const eventChange = homePlayerEloChange(
      margin,
      event.home_won ? 1 : 0,
      expected,
    );
    const playerChange = eventChange / (player2 ? 2 : 1);

    await db().prepare("UPDATE players SET current_elo = current_elo + ? WHERE id = ?")
      .bind(playerChange, player1.id).run();
    if (player2) {
      await db().prepare("UPDATE players SET current_elo = current_elo + ? WHERE id = ?")
        .bind(playerChange, player2.id).run();
    }
    if (yearWeight > 0) {
      await db().prepare(
        `INSERT INTO opponent_positions
         (id, home_school_id, opponent_school_id, position, current_elo, total_weight, matches_used)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           current_elo = excluded.current_elo,
           total_weight = excluded.total_weight,
           matches_used = opponent_positions.matches_used + 1`,
      ).bind(positionId, event.home_school_id, event.opponent_school_id, event.position, newOpponentElo, newWeight).run();
    }
  }

  for (const [schoolId, rows] of floorsBySchool) {
    const latestSeason = Math.max(...rows.map((row) => Number(row.season)));
    await applyFloorsThrough(schoolId, latestSeason);
  }


  const finalPlayers = await db().prepare(
    "SELECT school_id, player_code, current_elo FROM players",
  ).all<{ school_id: string; player_code: string; current_elo: number }>();
  const finalPlayerElo = new Map(
    finalPlayers.results.map((row) => [`${row.school_id}|${row.player_code.toLowerCase()}`, Number(row.current_elo)]),
  );
  const finalPositions = await db().prepare(
    "SELECT home_school_id, opponent_school_id, position, current_elo FROM opponent_positions",
  ).all<{ home_school_id: string; opponent_school_id: string; position: string; current_elo: number }>();
  const finalPositionElo = new Map(
    finalPositions.results.map((row) => [
      `${row.home_school_id}|${row.opponent_school_id}|${row.position}`,
      Number(row.current_elo),
    ]),
  );
  const calibrationGroups = new Map<string, {
    homeSchoolId: string;
    opponentSchoolId: string;
    actualWins: number;
    dates: Set<string>;
    samples: Array<{ homeElo: number; opponentElo: number }>;
  }>();
  for (const event of events.results) {
    if (Number(event.season_weight) <= 0) continue;
    const first = finalPlayerElo.get(`${event.home_school_id}|${event.home_player_1_code.toLowerCase()}`);
    const second = event.home_player_2_code
      ? finalPlayerElo.get(`${event.home_school_id}|${event.home_player_2_code.toLowerCase()}`)
      : 0;
    const opponent = finalPositionElo.get(`${event.home_school_id}|${event.opponent_school_id}|${event.position}`);
    if (first === undefined || second === undefined || opponent === undefined) continue;
    const key = `${event.home_school_id}|${event.opponent_school_id}`;
    const group = calibrationGroups.get(key) ?? {
      homeSchoolId: event.home_school_id,
      opponentSchoolId: event.opponent_school_id,
      actualWins: 0,
      dates: new Set<string>(),
      samples: [],
    };
    group.actualWins += Number(event.home_won);
    group.dates.add(event.match_date);
    group.samples.push({ homeElo: first + second, opponentElo: opponent });
    calibrationGroups.set(key, group);
  }
  for (const [id, group] of calibrationGroups) {
    const targetWins = smoothedHistoricalWins(group.actualWins, group.samples.length);
    const offset = fitOpponentEloOffset(group.samples, targetWins);
    const projectedWins = group.samples.reduce(
      (sum, sample) => sum + eloWinProbability(sample.homeElo, sample.opponentElo + offset),
      0,
    );
    await db().prepare(
      `INSERT INTO opponent_calibrations
       (id, home_school_id, opponent_school_id, elo_offset, actual_wins, projected_wins, event_count, meet_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      group.homeSchoolId,
      group.opponentSchoolId,
      offset,
      group.actualWins,
      projectedWins,
      group.samples.length,
      group.dates.size,
    ).run();
  }

  await db().prepare(
    `INSERT INTO model_metadata (key, value) VALUES ('rating_model_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).bind(RATING_MODEL_VERSION).run();
}

let ratingModelReady = false;

async function ensureCurrentRatingModel() {
  if (ratingModelReady) return;
  const stored = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = 'rating_model_version'",
  ).first<{ value: string }>();

  if (stored?.value !== RATING_MODEL_VERSION) {
    const matchCount = await db().prepare(
      "SELECT COUNT(*) AS count FROM match_events",
    ).first<{ count: number }>();
    if (Number(matchCount?.count ?? 0) > 0) {
      await recomputeRatings();
    } else {
      await db().prepare(
        `INSERT INTO model_metadata (key, value) VALUES ('rating_model_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(RATING_MODEL_VERSION).run();
    }
  }
  ratingModelReady = true;
}
