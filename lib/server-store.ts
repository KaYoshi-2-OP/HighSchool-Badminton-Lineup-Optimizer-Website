import { env } from "cloudflare:workers";
import {
  DEFAULT_EVENT_COUNTS,
  EVENT_ORDER,
  type EventCounts,
  type EventCode,
  type PlayerRecord,
  type PositionRating,
  type SeasonFormat,
  defaultPositionElo,
  eloWinProbability,
  fitOpponentEloOffset,
  homePlayerEloChange,
  isEventCode,
  normalizeGender,
  normalizeName,
  preseasonElo,
  makeSeasonFormat,
  schoolIdFromName,
  smoothedHistoricalWins,
} from "./domain";

const POINT_SCALE = 8;
const POSITION_SEASON_WINDOW = 10;
const RATING_MODEL_VERSION = "home-k2-fixed-home-calibrated-v3";

type CsvRow = Record<string, string | number | null | undefined>;

export type AccountContext = {
  id: string;
  username: string;
};

type DbPlayer = {
  id: string;
  school_id: string;
  player_code: string;
  display_name: string;
  normalized_name: string;
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

type DbSeasonFormat = {
  season: number;
  boys_singles: number;
  girls_singles: number;
  boys_doubles: number;
  girls_doubles: number;
  mixed_doubles: number;
};

type DbPlayerSeason = {
  player_id: string;
  school_id: string;
  season: number;
  rank: number;
  initialized_elo: number;
};

type ResolvedPlayer = {
  id: string;
  code: string;
  name: string;
  gender: "Boys" | "Girls";
  rank: number;
};

function jsonRows(rows: unknown[]): string {
  const payload = JSON.stringify(rows);
  if (new TextEncoder().encode(payload).byteLength > 1_900_000) {
    throw new Error("This import is too large for one request. Split it into smaller CSV files and upload them in date order.");
  }
  return payload;
}

function db() {
  if (!env.DB) throw new Error("Persistent database binding is unavailable.");
  return env.DB;
}

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;
  const requiredTables = [
    "accounts",
    "sessions",
    "login_attempts",
    "schools",
    "players",
    "player_aliases",
    "match_events",
    "opponent_positions",
    "model_metadata",
    "player_seasons",
    "season_formats",
    "opponent_calibrations",
  ];
  const existingTables = await db().prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))`,
  ).bind(jsonRows(requiredTables)).all<{ name: string }>();
  const existingNames = new Set(existingTables.results.map((row) => row.name));

  if (requiredTables.some((table) => !existingNames.has(table))) {
    await db().batch([
    db().prepare(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      username TEXT NOT NULL,
      normalized_username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_unique ON accounts (normalized_username)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare("CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id)"),
    db().prepare("CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
      normalized_username TEXT PRIMARY KEY NOT NULL,
      failed_count INTEGER DEFAULT 0 NOT NULL,
      window_started_at TEXT NOT NULL,
      locked_until TEXT
    )`),
    db().prepare(`CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT,
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
      account_id TEXT,
      school_id TEXT NOT NULL,
      alias_code TEXT NOT NULL,
      player_id TEXT NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS player_alias_school_code_unique ON player_aliases (school_id, alias_code)"),
    db().prepare("CREATE INDEX IF NOT EXISTS player_alias_player_idx ON player_aliases (player_id)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS match_events (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT,
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
      account_id TEXT,
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
      account_id TEXT,
      player_id TEXT NOT NULL,
      school_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      initialized_elo REAL NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS player_season_unique ON player_seasons (player_id, season)"),
    db().prepare("CREATE INDEX IF NOT EXISTS player_seasons_school_season_idx ON player_seasons (school_id, season)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS season_formats (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      home_school_id TEXT NOT NULL,
      season INTEGER NOT NULL,
      boys_singles INTEGER NOT NULL,
      girls_singles INTEGER NOT NULL,
      boys_doubles INTEGER NOT NULL,
      girls_doubles INTEGER NOT NULL,
      mixed_doubles INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS season_format_unique ON season_formats (account_id, home_school_id, season)"),
    db().prepare("CREATE INDEX IF NOT EXISTS season_formats_home_season_idx ON season_formats (home_school_id, season)"),
    db().prepare(`CREATE TABLE IF NOT EXISTS opponent_calibrations (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT,
      home_school_id TEXT NOT NULL,
      opponent_school_id TEXT NOT NULL,
      elo_offset REAL NOT NULL,
      actual_wins REAL NOT NULL,
      projected_wins REAL NOT NULL,
      event_count INTEGER NOT NULL,
      meet_count INTEGER NOT NULL
    )`),
    db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS opponent_calibration_unique ON opponent_calibrations (home_school_id, opponent_school_id)"),
    ]);
  }

  const accountTables = [
    "schools",
    "players",
    "player_aliases",
    "match_events",
    "opponent_positions",
    "player_seasons",
    "season_formats",
    "opponent_calibrations",
  ];
  const accountColumns = await db().prepare(
    `SELECT m.name AS table_name, p.name AS column_name
     FROM sqlite_master AS m, pragma_table_info(m.name) AS p
     WHERE m.type = 'table' AND m.name IN (SELECT value FROM json_each(?))
       AND p.name = 'account_id'`,
  ).bind(jsonRows(accountTables)).all<{ table_name: string; column_name: string }>();
  const tablesWithAccount = new Set(accountColumns.results.map((row) => row.table_name));
  const missingAccountColumns = accountTables.filter((table) => !tablesWithAccount.has(table));
  if (missingAccountColumns.length) {
    await db().batch(missingAccountColumns.map((table) => (
      db().prepare(`ALTER TABLE ${table} ADD COLUMN account_id TEXT`)
    )));
  }

  if (existingTables.results.length !== requiredTables.length || missingAccountColumns.length) {
    await db().batch([
      db().prepare("DROP INDEX IF EXISTS accounts_email_unique"),
      db().prepare("DROP INDEX IF EXISTS schools_name_unique"),
      db().prepare("CREATE UNIQUE INDEX IF NOT EXISTS schools_account_name_unique ON schools (account_id, name)"),
      db().prepare("CREATE INDEX IF NOT EXISTS schools_account_idx ON schools (account_id)"),
      db().prepare("CREATE INDEX IF NOT EXISTS players_account_idx ON players (account_id)"),
      db().prepare("CREATE INDEX IF NOT EXISTS match_events_account_idx ON match_events (account_id)"),
      db().prepare(
        `INSERT OR IGNORE INTO player_seasons
         (id, account_id, player_id, school_id, season, rank, initialized_elo)
         SELECT id || ':' || last_season, account_id, id, school_id, last_season, rank, initial_elo FROM players`,
      ),
    ]);
  }
  schemaReady = true;
}

function accountSchoolId(accountId: string, schoolName: string): string {
  return `${accountId}:${schoolIdFromName(schoolName)}`;
}

function metadataKey(accountId: string, key: string): string {
  return `${accountId}:${key}`;
}

async function claimLegacyData(accountId: string) {

  const legacy = await db().prepare(
    "SELECT COUNT(*) AS count FROM schools WHERE account_id IS NULL",
  ).first<{ count: number }>();
  if (Number(legacy?.count ?? 0) === 0) return;

  await db().batch([
    db().prepare("UPDATE schools SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE players SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE player_aliases SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE match_events SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE opponent_positions SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE player_seasons SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE season_formats SET account_id = ? WHERE account_id IS NULL").bind(accountId),
    db().prepare("UPDATE opponent_calibrations SET account_id = ? WHERE account_id IS NULL").bind(accountId),
  ]);

  const legacyMetadata = await db().prepare(
    "SELECT key, value FROM model_metadata WHERE key IN (SELECT value FROM json_each(?))",
  ).bind(jsonRows(["home_school_id", "demo_seeded", "rating_model_version"]))
    .all<{ key: string; value: string }>();
  if (legacyMetadata.results.length) {
    await db().prepare(
      `INSERT OR IGNORE INTO model_metadata (key, value)
       SELECT json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?)`,
    ).bind(jsonRows(legacyMetadata.results.map((row) => ({
      key: metadataKey(accountId, row.key),
      value: row.value,
    })))).run();
  }
}

export async function initializeAccountWorkspace(accountId: string, claimLegacy: boolean) {
  await ensureSchema();
  if (claimLegacy) await claimLegacyData(accountId);
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

function mapSeasonFormat(row: DbSeasonFormat, configured = true): SeasonFormat {
  return makeSeasonFormat(Number(row.season), {
    boysSingles: Number(row.boys_singles),
    girlsSingles: Number(row.girls_singles),
    boysDoubles: Number(row.boys_doubles),
    girlsDoubles: Number(row.girls_doubles),
    mixedDoubles: Number(row.mixed_doubles),
  }, configured);
}

async function activeRosterSeason(accountId: string, homeSchoolId: string): Promise<number> {
  const row = await db().prepare(
    "SELECT MAX(last_season) AS season FROM players WHERE account_id = ? AND school_id = ?",
  ).bind(accountId, homeSchoolId).first<{ season: number | null }>();
  return Number(row?.season ?? new Date().getUTCFullYear());
}

async function readSeasonFormat(
  accountId: string,
  homeSchoolId: string,
  season: number,
): Promise<SeasonFormat> {
  const row = await db().prepare(
    `SELECT season, boys_singles, girls_singles, boys_doubles, girls_doubles, mixed_doubles
     FROM season_formats WHERE account_id = ? AND home_school_id = ? AND season = ?`,
  ).bind(accountId, homeSchoolId, season).first<DbSeasonFormat>();
  if (row) return mapSeasonFormat(row);
  const existingPositions = await db().prepare(
    `SELECT DISTINCT position FROM match_events
     WHERE account_id = ? AND home_school_id = ? AND season_year = ?`,
  ).bind(accountId, homeSchoolId, season).all<{ position: string }>();
  if (existingPositions.results.length) {
    const counts: EventCounts = {
      boysSingles: 0,
      girlsSingles: 0,
      boysDoubles: 0,
      girlsDoubles: 0,
      mixedDoubles: 0,
    };
    for (const [prefix, key] of [
      ["BS", "boysSingles"],
      ["GS", "girlsSingles"],
      ["BD", "boysDoubles"],
      ["GD", "girlsDoubles"],
      ["XD", "mixedDoubles"],
    ] as Array<[string, keyof EventCounts]>) {
      const maximum = Math.max(0, ...existingPositions.results
        .filter((entry) => entry.position.startsWith(prefix))
        .map((entry) => Number(entry.position.slice(2)) || 0));
      if (maximum > 0) counts[key] = maximum;
    }
    return makeSeasonFormat(season, counts, false);
  }
  return makeSeasonFormat(season, DEFAULT_EVENT_COUNTS, false);
}

async function listSeasonFormats(accountId: string, homeSchoolId: string, activeSeason: number) {
  const rows = await db().prepare(
    `SELECT season, boys_singles, girls_singles, boys_doubles, girls_doubles, mixed_doubles
     FROM season_formats WHERE account_id = ? AND home_school_id = ? ORDER BY season`,
  ).bind(accountId, homeSchoolId).all<DbSeasonFormat>();
  const formats = rows.results.map((row) => mapSeasonFormat(row));
  if (!formats.some((format) => format.season === activeSeason)) {
    formats.push(makeSeasonFormat(activeSeason, DEFAULT_EVENT_COUNTS, false));
  }
  return formats.sort((a, b) => a.season - b.season);
}

export async function saveSeasonFormat(
  account: AccountContext,
  payload: { season: number } & EventCounts,
) {
  await ensureSchema();
  const homeSchoolId = await readHomeSchoolId(account.id);
  if (!homeSchoolId) throw new Error("Import the home-school roster before setting a league format.");
  const format = makeSeasonFormat(Number(payload.season), {
    boysSingles: Number(payload.boysSingles),
    girlsSingles: Number(payload.girlsSingles),
    boysDoubles: Number(payload.boysDoubles),
    girlsDoubles: Number(payload.girlsDoubles),
    mixedDoubles: Number(payload.mixedDoubles),
  }, true);
  const existing = await readSeasonFormat(account.id, homeSchoolId, format.season);
  const recorded = await db().prepare(
    `SELECT COUNT(*) AS count FROM match_events
     WHERE account_id = ? AND home_school_id = ? AND season_year = ?`,
  ).bind(account.id, homeSchoolId, format.season).first<{ count: number }>();
  const unchanged = existing.eventOrder.join("|") === format.eventOrder.join("|");
  if (Number(recorded?.count ?? 0) > 0 && !unchanged) {
    throw new Error(
      `The ${format.season} format cannot be changed because results already exist for that season.`,
    );
  }
  const id = `${account.id}|${homeSchoolId}|${format.season}`;
  await db().prepare(
    `INSERT INTO season_formats
     (id, account_id, home_school_id, season, boys_singles, girls_singles,
      boys_doubles, girls_doubles, mixed_doubles, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id, home_school_id, season) DO UPDATE SET
       boys_singles = excluded.boys_singles,
       girls_singles = excluded.girls_singles,
       boys_doubles = excluded.boys_doubles,
       girls_doubles = excluded.girls_doubles,
       mixed_doubles = excluded.mixed_doubles,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(
    id,
    account.id,
    homeSchoolId,
    format.season,
    format.boysSingles,
    format.girlsSingles,
    format.boysDoubles,
    format.girlsDoubles,
    format.mixedDoubles,
  ).run();
  return { format };
}

async function ensureSchool(accountId: string, name: string): Promise<string> {
  const schoolName = name.trim();
  const existing = await db().prepare(
    "SELECT id FROM schools WHERE account_id = ? AND name = ? COLLATE NOCASE LIMIT 1",
  ).bind(accountId, schoolName).first<{ id: string }>();
  if (existing?.id) return existing.id;
  const id = accountSchoolId(accountId, schoolName);
  await db()
    .prepare("INSERT OR IGNORE INTO schools (id, account_id, name) VALUES (?, ?, ?)")
    .bind(id, accountId, schoolName)
    .run();
  return id;
}

async function readHomeSchoolId(accountId: string): Promise<string | null> {
  const homeKey = metadataKey(accountId, "home_school_id");
  const stored = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = ?",
  ).bind(homeKey).first<{ value: string }>();
  if (stored?.value) return stored.value;

  const rosterLeader = await db().prepare(
    `SELECT school_id AS id, COUNT(*) AS count FROM players
     WHERE account_id = ? GROUP BY school_id ORDER BY count DESC LIMIT 1`,
  ).bind(accountId).first<{ id: string; count: number }>();
  if (!rosterLeader?.id) return null;
  const demoHome = await db().prepare(
    "SELECT id FROM schools WHERE account_id = ? AND name = 'North Valley High' LIMIT 1",
  ).bind(accountId).first<{ id: string }>();
  if (demoHome?.id && rosterLeader.id !== demoHome.id) {
    const demoMatches = await db().prepare(
      "SELECT COUNT(*) AS count FROM match_events WHERE account_id = ? AND home_school_id = ?",
    ).bind(accountId, demoHome.id).first<{ count: number }>();
    if (Number(demoMatches?.count ?? 0) === 0) {
      await db().batch([
        db().prepare("DELETE FROM player_seasons WHERE account_id = ? AND school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM season_formats WHERE account_id = ? AND home_school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM player_aliases WHERE account_id = ? AND school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM players WHERE account_id = ? AND school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM opponent_positions WHERE account_id = ? AND home_school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM opponent_calibrations WHERE account_id = ? AND home_school_id = ?").bind(accountId, demoHome.id),
        db().prepare("DELETE FROM schools WHERE account_id = ? AND name IN ('North Valley High', 'East Ridge High')").bind(accountId),
      ]);
    }
  }
  await db().prepare(
    "INSERT OR IGNORE INTO model_metadata (key, value) VALUES (?, ?)",
  ).bind(homeKey, rosterLeader.id).run();
  const locked = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = ?",
  ).bind(homeKey).first<{ value: string }>();
  return locked?.value ?? rosterLeader.id;
}

async function lockHomeSchool(accountId: string, schoolId: string) {
  let current = await readHomeSchoolId(accountId);
  const demoKey = metadataKey(accountId, "demo_seeded");
  const demoSeed = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = ?",
  ).bind(demoKey).first<{ value: string }>();
  const demoHome = await db().prepare(
    "SELECT id FROM schools WHERE account_id = ? AND name = 'North Valley High' LIMIT 1",
  ).bind(accountId).first<{ id: string }>();
  if (demoHome?.id && current === demoHome.id && schoolId !== current && demoSeed?.value === "1") {
    await db().batch([
      db().prepare("DELETE FROM player_seasons WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM season_formats WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM player_aliases WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM players WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM match_events WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM opponent_positions WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM opponent_calibrations WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM schools WHERE account_id = ?").bind(accountId),
      db().prepare("DELETE FROM model_metadata WHERE key IN (?, ?, ?)").bind(
        metadataKey(accountId, "home_school_id"),
        metadataKey(accountId, "demo_seeded"),
        metadataKey(accountId, "rating_model_version"),
      ),
    ]);
    current = null;
  }
  if (current && current !== schoolId) {
    throw new Error("This site is already locked to a different home school.");
  }
  if (!current) {
    await db().prepare(
      "INSERT OR IGNORE INTO model_metadata (key, value) VALUES (?, ?)",
    ).bind(metadataKey(accountId, "home_school_id"), schoolId).run();
    const locked = await db().prepare(
      "SELECT value FROM model_metadata WHERE key = ?",
    ).bind(metadataKey(accountId, "home_school_id")).first<{ value: string }>();
    if (locked?.value && locked.value !== schoolId) {
      throw new Error("This site is already locked to a different home school.");
    }
  }
}

export async function ensureDemoData(account: AccountContext) {
  await ensureSchema();
  const existing = await db().prepare("SELECT COUNT(*) AS count FROM schools WHERE account_id = ?")
    .bind(account.id).first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) return;

  const homeId = accountSchoolId(account.id, "North Valley High");
  const opponentId = accountSchoolId(account.id, "East Ridge High");
  const players: Array<Record<string, string | number>> = [];
  const aliases: Array<Record<string, string>> = [];

  for (const [gender, prefix] of [["Boys", "B"], ["Girls", "G"]] as const) {
    for (let rank = 1; rank <= 13; rank += 1) {
      const code = `${prefix}${rank}`;
      const id = `${homeId}:${code.toLowerCase()}`;
      const rating = preseasonElo(rank, 13);
      players.push({
        id,
        schoolId: homeId,
        code,
        name: `Player ${code}`,
        normalizedName: normalizeName(`Player ${code}`),
        gender,
        rank,
        rating,
      });
      aliases.push({ id: `${homeId}:${code.toLowerCase()}`, schoolId: homeId, code: code.toLowerCase(), playerId: id });
    }
  }

  const positions: Array<Record<string, string | number>> = [];
  for (const position of EVENT_ORDER) {
    const number = Number(position.at(-1));
    const rating = position.startsWith("BS") || position.startsWith("GS")
      ? 2140 - number * 120
      : 3600 - number * 140;
    positions.push({ id: `${homeId}|${opponentId}|${position}`, homeId, opponentId, position, rating });
  }
  await db().batch([
    db().prepare(
      `INSERT OR IGNORE INTO schools (id, account_id, name)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name') FROM json_each(?)`,
    ).bind(account.id, jsonRows([
      { id: homeId, name: "North Valley High" },
      { id: opponentId, name: "East Ridge High" },
    ])),
    db().prepare(
      `INSERT OR IGNORE INTO model_metadata (key, value)
       SELECT json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?)`,
    ).bind(jsonRows([
      { key: metadataKey(account.id, "home_school_id"), value: homeId },
      { key: metadataKey(account.id, "demo_seeded"), value: "1" },
    ])),
    db().prepare(
      `INSERT OR IGNORE INTO season_formats
       (id, account_id, home_school_id, season, boys_singles, girls_singles,
        boys_doubles, girls_doubles, mixed_doubles)
       VALUES (?, ?, ?, 2026, 4, 4, 3, 3, 3)`,
    ).bind(`${account.id}|${homeId}|2026`, account.id, homeId),
    db().prepare(
      `INSERT OR IGNORE INTO players
       (id, account_id, school_id, player_code, display_name, normalized_name, gender, rank,
        initial_elo, current_elo, first_season, last_season, active)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.schoolId'),
        json_extract(value, '$.code'), json_extract(value, '$.name'),
        json_extract(value, '$.normalizedName'), json_extract(value, '$.gender'),
        json_extract(value, '$.rank'), json_extract(value, '$.rating'),
        json_extract(value, '$.rating'), 2026, 2026, 1 FROM json_each(?)`,
    ).bind(account.id, jsonRows(players)),
    db().prepare(
      `INSERT OR IGNORE INTO player_aliases (id, account_id, school_id, alias_code, player_id)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.schoolId'),
        json_extract(value, '$.code'), json_extract(value, '$.playerId') FROM json_each(?)`,
    ).bind(account.id, jsonRows(aliases)),
    db().prepare(
      `INSERT OR IGNORE INTO opponent_positions
       (id, account_id, home_school_id, opponent_school_id, position, current_elo, total_weight, matches_used)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.homeId'),
        json_extract(value, '$.opponentId'), json_extract(value, '$.position'),
        json_extract(value, '$.rating'), 6, 3 FROM json_each(?)`,
    ).bind(account.id, jsonRows(positions)),
  ]);
}

export async function getDashboard(account: AccountContext, opponentSchoolId?: string) {
  await ensureDemoData(account);
  await ensureCurrentRatingModel(account.id);
  const homeSchoolId = await readHomeSchoolId(account.id);
  const schoolRows = await db().prepare("SELECT id, name FROM schools WHERE account_id = ? ORDER BY name")
    .bind(account.id).all<{ id: string; name: string }>();
  const schools = schoolRows.results;
  const selectedHome = schools.find((school) => school.id === homeSchoolId) ?? schools[0];
  const selectedOpponent = schools.find((school) => school.id === opponentSchoolId && school.id !== selectedHome.id)
    ?? schools.find((school) => school.id !== selectedHome.id)
    ?? null;
  const rosterSeason = await activeRosterSeason(account.id, selectedHome.id);
  const seasonFormat = await readSeasonFormat(account.id, selectedHome.id, rosterSeason);
  const seasonFormats = await listSeasonFormats(account.id, selectedHome.id, rosterSeason);

  const playerRows = await db().prepare(
    "SELECT * FROM players WHERE account_id = ? AND school_id = ? ORDER BY gender, rank, display_name",
  ).bind(account.id, selectedHome.id).all<DbPlayer>();

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
       WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
    ).bind(account.id, selectedHome.id, selectedOpponent.id).all<DbPosition>();
    const calibration = await db().prepare(
      `SELECT elo_offset, actual_wins, projected_wins, event_count, meet_count
       FROM opponent_calibrations
       WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
    ).bind(account.id, selectedHome.id, selectedOpponent.id).first<DbCalibration>();
    const offset = Number(calibration?.elo_offset ?? 0);
    const byEvent = new Map(positionRows.results.map((row) => [row.position, row]));
    positions = seasonFormat.eventOrder.map((position) => {
      const row = byEvent.get(position);
      return {
        position,
        currentElo: Number(row?.current_elo ?? defaultPositionElo(position)) + offset,
        totalWeight: Number(row?.total_weight ?? 0),
        matchesUsed: Number(row?.matches_used ?? 0),
      };
    });
    if (calibration && Number(calibration.meet_count) > 0) {
      const eventCount = Number(calibration.event_count);
      historicalFit = {
        actualWinsPerMeet: eventCount > 0
          ? Number(calibration.actual_wins) / eventCount * seasonFormat.totalEvents
          : 0,
        projectedWinsPerMeet: eventCount > 0
          ? Number(calibration.projected_wins) / eventCount * seasonFormat.totalEvents
          : 0,
        meetCount: Number(calibration.meet_count),
        eloOffset: offset,
      };
    }
  }

  const yearRows = await db().prepare(
    `SELECT season_year AS year, MAX(season_weight) AS weight
     FROM match_events WHERE account_id = ? AND home_school_id = ? AND season_weight > 0
     GROUP BY season_year ORDER BY season_year`,
  ).bind(account.id, selectedHome.id).all<{ year: number; weight: number }>();
  const matchCount = await db().prepare(
    "SELECT COUNT(*) AS count FROM match_events WHERE account_id = ? AND home_school_id = ?",
  ).bind(account.id, selectedHome.id).first<{ count: number }>();

  const players = playerRows.results.map(mapPlayer);
  return {
    schools,
    selectedHome,
    selectedOpponent,
    homeLocked: true,
    players,
    positions,
    rosterSeason,
    seasonFormat,
    seasonFormats,
    yearWeights: yearRows.results.map((row) => ({ year: Number(row.year), weight: Number(row.weight) })),
    matchCount: Number(matchCount?.count ?? 0),
    returningPlayers: players.filter((player) => player.firstSeason < player.lastSeason).length,
    historicalFit,
    demo: selectedHome.name === "North Valley High",
  };
}

async function findPlayer(accountId: string, schoolId: string, code: string, name?: string) {
  const normalizedCode = code.trim().toLowerCase();
  const byAlias = normalizedCode
    ? await db().prepare(
        `SELECT p.* FROM player_aliases a
         JOIN players p ON p.id = a.player_id
         WHERE a.account_id = ? AND a.school_id = ? AND a.alias_code = ?`,
      ).bind(accountId, schoolId, normalizedCode).first<DbPlayer>()
    : null;
  if (byAlias) return byAlias;
  const normalized = normalizeName(name ?? "");
  if (!normalized) return null;
  return db().prepare(
    "SELECT * FROM players WHERE account_id = ? AND school_id = ? AND normalized_name = ? LIMIT 1",
  ).bind(accountId, schoolId, normalized).first<DbPlayer>();
}

export async function importRosters(account: AccountContext, rows: CsvRow[]) {
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
      schoolId: "",
      season,
      code,
      name,
      gender: normalizeGender(text(row, "gender")),
      rank,
      active: !["0", "false", "no", "inactive"].includes(text(row, "active").toLowerCase()),
      ladderSize,
    });
  }

  const requestedSchoolNames = [...new Set(prepared.map((row) => row.schoolName.trim().toLowerCase()))];
  if (requestedSchoolNames.length !== 1) {
    throw new Error("A roster file must contain exactly one home school.");
  }
  const importedSchoolId = await ensureSchool(account.id, prepared[0].schoolName);
  for (const row of prepared) row.schoolId = importedSchoolId;
  await lockHomeSchool(account.id, importedSchoolId);

  let created = 0;
  let continued = 0;
  const schoolId = importedSchoolId;
  const schoolRows = prepared.filter((row) => row.schoolId === schoolId);
  const [existingPlayersResult, existingAliasesResult] = await db().batch([
    db().prepare("SELECT * FROM players WHERE account_id = ? AND school_id = ?").bind(account.id, schoolId),
    db().prepare(
      "SELECT alias_code, player_id FROM player_aliases WHERE account_id = ? AND school_id = ?",
    ).bind(account.id, schoolId),
  ]);
  const existingPlayers = (existingPlayersResult.results ?? []) as DbPlayer[];
  const existingAliases = (existingAliasesResult.results ?? []) as Array<{ alias_code: string; player_id: string }>;
  const playersById = new Map(existingPlayers.map((player) => [player.id, { ...player }]));
  const aliasesByCode = new Map<string, DbPlayer>();
  for (const player of playersById.values()) {
    aliasesByCode.set(player.player_code.toLowerCase(), player);
  }
  for (const alias of existingAliases) {
    const player = playersById.get(alias.player_id);
    if (player) aliasesByCode.set(alias.alias_code.toLowerCase(), player);
  }

  const latestImportSeason = Math.max(...schoolRows.map((row) => row.season));
  const existingLatest = Math.max(0, ...existingPlayers.map((player) => Number(player.last_season)));
  const changesActiveRoster = latestImportSeason >= existingLatest;
  if (changesActiveRoster) {
    for (const player of playersById.values()) player.active = 0;
  }

  const groupSizes = new Map<string, number>();
  for (const row of schoolRows) {
    const key = `${row.season}:${row.gender}`;
    groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
  }

  const touchedPlayers = new Map<string, DbPlayer>();
  const aliasWrites = new Map<string, { id: string; schoolId: string; code: string; playerId: string }>();
  const seasonWrites = new Map<string, {
    id: string;
    playerId: string;
    schoolId: string;
    season: number;
    rank: number;
    initializedElo: number;
  }>();

  for (const row of schoolRows.sort((a, b) => a.season - b.season || a.rank - b.rank)) {
    const aliasCode = row.code.toLowerCase();
    let player = aliasesByCode.get(aliasCode);
    const size = row.ladderSize ?? groupSizes.get(`${row.season}:${row.gender}`) ?? 1;
    const initializedElo = preseasonElo(row.rank, size);
    if (player) {
      continued += 1;
      const isEarlierSeason = row.season < Number(player.first_season);
      const appliesToCurrentElo = row.season >= Number(player.last_season);
      player.display_name = row.name;
      player.normalized_name = normalizeName(row.name);
      player.gender = row.gender;
      player.rank = row.rank;
      if (isEarlierSeason) player.initial_elo = initializedElo;
      if (appliesToCurrentElo && Number(player.current_elo) < initializedElo) {
        player.current_elo = initializedElo;
      }
      player.first_season = Math.min(Number(player.first_season), row.season);
      player.last_season = Math.max(Number(player.last_season), row.season);
      player.active = changesActiveRoster && row.season === latestImportSeason
        ? Number(row.active)
        : Number(player.active);
    } else {
      created += 1;
      const playerId = `${schoolId}:${aliasCode}`;
      player = {
        id: playerId,
        school_id: schoolId,
        player_code: row.code,
        display_name: row.name,
        normalized_name: normalizeName(row.name),
        gender: row.gender,
        rank: row.rank,
        initial_elo: initializedElo,
        current_elo: initializedElo,
        first_season: row.season,
        last_season: row.season,
        active: changesActiveRoster && row.season === latestImportSeason ? Number(row.active) : 0,
      };
      playersById.set(playerId, player);
      aliasesByCode.set(aliasCode, player);
    }
    touchedPlayers.set(player.id, player);
    aliasWrites.set(aliasCode, {
      id: `${schoolId}:${aliasCode}`,
      schoolId,
      code: aliasCode,
      playerId: player.id,
    });
    seasonWrites.set(`${player.id}:${row.season}`, {
      id: `${player.id}:${row.season}`,
      playerId: player.id,
      schoolId,
      season: row.season,
      rank: row.rank,
      initializedElo,
    });
  }

  const playerPayload = [...touchedPlayers.values()].map((player) => ({
    id: player.id,
    schoolId: player.school_id,
    code: player.player_code,
    name: player.display_name,
    normalizedName: player.normalized_name,
    gender: player.gender,
    rank: Number(player.rank),
    initialElo: Number(player.initial_elo),
    currentElo: Number(player.current_elo),
    firstSeason: Number(player.first_season),
    lastSeason: Number(player.last_season),
    active: Number(player.active),
  }));
  const writes = changesActiveRoster
    ? [db().prepare("UPDATE players SET active = 0 WHERE account_id = ? AND school_id = ?")
      .bind(account.id, schoolId)]
    : [];
  writes.push(
    db().prepare(
      `INSERT INTO players
       (id, account_id, school_id, player_code, display_name, normalized_name, gender, rank,
        initial_elo, current_elo, first_season, last_season, active)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.schoolId'),
        json_extract(value, '$.code'), json_extract(value, '$.name'),
        json_extract(value, '$.normalizedName'), json_extract(value, '$.gender'),
        json_extract(value, '$.rank'), json_extract(value, '$.initialElo'),
        json_extract(value, '$.currentElo'), json_extract(value, '$.firstSeason'),
        json_extract(value, '$.lastSeason'), json_extract(value, '$.active')
       FROM json_each(?) WHERE true
       ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        normalized_name = excluded.normalized_name,
        gender = excluded.gender,
        rank = excluded.rank,
        initial_elo = excluded.initial_elo,
        current_elo = excluded.current_elo,
        first_season = excluded.first_season,
        last_season = excluded.last_season,
        active = excluded.active`,
    ).bind(account.id, jsonRows(playerPayload)),
    db().prepare(
      `INSERT INTO player_aliases (id, account_id, school_id, alias_code, player_id)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.schoolId'),
        json_extract(value, '$.code'), json_extract(value, '$.playerId')
       FROM json_each(?) WHERE true
       ON CONFLICT(id) DO UPDATE SET player_id = excluded.player_id`,
    ).bind(account.id, jsonRows([...aliasWrites.values()])),
    db().prepare(
      `INSERT INTO player_seasons
       (id, account_id, player_id, school_id, season, rank, initialized_elo)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.playerId'),
        json_extract(value, '$.schoolId'), json_extract(value, '$.season'),
        json_extract(value, '$.rank'), json_extract(value, '$.initializedElo')
       FROM json_each(?) WHERE true
       ON CONFLICT(player_id, season) DO UPDATE SET
        rank = excluded.rank, initialized_elo = excluded.initialized_elo`,
    ).bind(account.id, jsonRows([...seasonWrites.values()])),
  );
  await db().batch(writes);

  return { created, continued, schools: 1 };
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
  player1Info: ResolvedPlayer;
  player2Info: ResolvedPlayer | null;
  seasonFormat: SeasonFormat;
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

async function parseMatchRows(account: AccountContext, rows: CsvRow[], createOpponentSchools: boolean) {
  if (!rows.length) throw new Error("The match data contains no event rows.");
  const lockedHomeSchoolId = await readHomeSchoolId(account.id);
  if (!lockedHomeSchoolId) throw new Error("Import the home-school roster before importing matches.");

  const [schoolResult, playerResult, aliasResult, playerSeasonResult, formatResult, positionResult] = await db().batch([
    db().prepare("SELECT id, name FROM schools WHERE account_id = ?").bind(account.id),
    db().prepare("SELECT * FROM players WHERE account_id = ? AND school_id = ?").bind(account.id, lockedHomeSchoolId),
    db().prepare(
      "SELECT alias_code, player_id FROM player_aliases WHERE account_id = ? AND school_id = ?",
    ).bind(account.id, lockedHomeSchoolId),
    db().prepare(
      `SELECT player_id, school_id, season, rank, initialized_elo
       FROM player_seasons WHERE account_id = ? AND school_id = ?`,
    ).bind(account.id, lockedHomeSchoolId),
    db().prepare(
      `SELECT season, boys_singles, girls_singles, boys_doubles, girls_doubles, mixed_doubles
       FROM season_formats WHERE account_id = ? AND home_school_id = ?`,
    ).bind(account.id, lockedHomeSchoolId),
    db().prepare(
      `SELECT DISTINCT season_year, position FROM match_events
       WHERE account_id = ? AND home_school_id = ?`,
    ).bind(account.id, lockedHomeSchoolId),
  ]);
  const schools = (schoolResult.results ?? []) as Array<{ id: string; name: string }>;
  const players = (playerResult.results ?? []) as DbPlayer[];
  const aliases = (aliasResult.results ?? []) as Array<{ alias_code: string; player_id: string }>;
  const playerSeasons = (playerSeasonResult.results ?? []) as DbPlayerSeason[];
  const savedFormats = (formatResult.results ?? []) as DbSeasonFormat[];
  const recordedPositions = (positionResult.results ?? []) as Array<{ season_year: number; position: string }>;
  const schoolsByName = new Map(schools.map((school) => [school.name.trim().toLowerCase(), school]));

  const missingOpponents = new Map<string, { id: string; name: string }>();
  for (const row of rows) {
    const opponentName = text(row, "opponent_school");
    const key = opponentName.toLowerCase();
    if (opponentName && !schoolsByName.has(key) && !missingOpponents.has(key)) {
      missingOpponents.set(key, { id: accountSchoolId(account.id, opponentName), name: opponentName });
    }
  }
  if (missingOpponents.size && createOpponentSchools) {
    const additions = [...missingOpponents.values()];
    await db().prepare(
      `INSERT OR IGNORE INTO schools (id, account_id, name)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name') FROM json_each(?)`,
    ).bind(account.id, jsonRows(additions)).run();
    for (const school of additions) schoolsByName.set(school.name.toLowerCase(), school);
  }

  const playersById = new Map(players.map((player) => [player.id, player]));
  const playersByCode = new Map<string, DbPlayer>();
  for (const player of players) playersByCode.set(player.player_code.toLowerCase(), player);
  for (const alias of aliases) {
    const player = playersById.get(alias.player_id);
    if (player) playersByCode.set(alias.alias_code.toLowerCase(), player);
  }
  const rankByPlayerSeason = new Map(
    playerSeasons.map((row) => [`${row.player_id}:${Number(row.season)}`, Number(row.rank)]),
  );

  const savedFormatByYear = new Map(savedFormats.map((row) => [Number(row.season), mapSeasonFormat(row)]));
  const positionsByYear = new Map<number, string[]>();
  for (const row of recordedPositions) {
    const year = Number(row.season_year);
    const positions = positionsByYear.get(year) ?? [];
    positions.push(row.position);
    positionsByYear.set(year, positions);
  }
  const formatByYear = new Map<number, SeasonFormat>();
  const formatForYear = (year: number) => {
    const cached = formatByYear.get(year);
    if (cached) return cached;
    const saved = savedFormatByYear.get(year);
    if (saved) {
      formatByYear.set(year, saved);
      return saved;
    }
    const historical = positionsByYear.get(year) ?? [];
    const counts: EventCounts = { ...DEFAULT_EVENT_COUNTS };
    if (historical.length) {
      for (const key of Object.keys(counts) as Array<keyof EventCounts>) counts[key] = 0;
      for (const [prefix, key] of [
        ["BS", "boysSingles"],
        ["GS", "girlsSingles"],
        ["BD", "boysDoubles"],
        ["GD", "girlsDoubles"],
        ["XD", "mixedDoubles"],
      ] as Array<[string, keyof EventCounts]>) {
        counts[key] = Math.max(0, ...historical
          .filter((position) => position.startsWith(prefix))
          .map((position) => Number(position.slice(2)) || 0));
      }
    }
    const format = makeSeasonFormat(year, counts, false);
    formatByYear.set(year, format);
    return format;
  };

  const parsed: ParsedMatch[] = [];
  for (const [index, row] of rows.entries()) {
    const date = text(row, "date");
    const matchDate = new Date(`${date}T00:00:00Z`);
    const positionText = text(row, "position").toUpperCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(matchDate.valueOf())
      || matchDate.toISOString().slice(0, 10) !== date) {
      throw new Error(`Match row ${index + 2}: date must use YYYY-MM-DD.`);
    }
    if (!isEventCode(positionText)) throw new Error(`Match row ${index + 2}: invalid position.`);
    const year = matchDate.getUTCFullYear();
    const seasonFormat = formatForYear(year);
    if (!seasonFormat.eventOrder.includes(positionText)) {
      throw new Error(
        `Match row ${index + 2}: ${positionText} is not part of the saved ${year} league format.`,
      );
    }
    const homeName = text(row, "home_school");
    const opponentName = text(row, "opponent_school");
    const player1 = text(row, "home_player_1");
    const player2Text = text(row, "home_player_2");
    const needsPair = positionText.startsWith("BD") || positionText.startsWith("GD") || positionText.startsWith("XD");
    if (!homeName || !opponentName || !player1 || (needsPair && !player2Text)) {
      throw new Error(`Match row ${index + 2} is missing a required value.`);
    }
    const homeSchoolId = schoolsByName.get(homeName.toLowerCase())?.id;
    if (!homeSchoolId) {
      throw new Error(`Match row ${index + 2}: home_school is not in this account.`);
    }
    if (homeSchoolId !== lockedHomeSchoolId) {
      throw new Error(`Match row ${index + 2}: home_school must match this account's locked home school.`);
    }
    const opponentSchoolId = schoolsByName.get(opponentName.toLowerCase())?.id;
    if (!opponentSchoolId) {
      throw new Error(`Match row ${index + 2}: the selected opponent is not in the database.`);
    }
    if (homeSchoolId === opponentSchoolId) throw new Error(`Match row ${index + 2}: schools must be different.`);
    const firstPlayer = playersByCode.get(player1.toLowerCase());
    const secondPlayer = player2Text ? playersByCode.get(player2Text.toLowerCase()) ?? null : null;
    if (!firstPlayer || (needsPair && !secondPlayer)) {
      throw new Error(`Match row ${index + 2}: import the home roster before its matches.`);
    }
    const games = parseGames(row);
    const wins = games.filter(([home, opponent]) => home > opponent).length;
    parsed.push({
      date,
      year,
      homeSchoolId,
      opponentSchoolId,
      position: positionText,
      player1: firstPlayer.player_code,
      player2: secondPlayer?.player_code ?? null,
      games,
      pointDifferential: games.reduce((sum, [home, opponent]) => sum + home - opponent, 0),
      homeWon: wins === 2,
      player1Info: {
        id: firstPlayer.id,
        code: firstPlayer.player_code,
        name: firstPlayer.display_name,
        gender: normalizeGender(firstPlayer.gender),
        rank: rankByPlayerSeason.get(`${firstPlayer.id}:${year}`) ?? Number(firstPlayer.rank),
      },
      player2Info: secondPlayer ? {
        id: secondPlayer.id,
        code: secondPlayer.player_code,
        name: secondPlayer.display_name,
        gender: normalizeGender(secondPlayer.gender),
        rank: rankByPlayerSeason.get(`${secondPlayer.id}:${year}`) ?? Number(secondPlayer.rank),
      } : null,
      seasonFormat,
    });
  }

  return parsed;
}

async function validateCompleteMeet(account: AccountContext, parsed: ParsedMatch[]) {
  const first = parsed[0];
  const seasonFormat = first.seasonFormat;
  if (parsed.length !== seasonFormat.totalEvents) {
    throw new Error(`A complete ${first.year} meet requires exactly ${seasonFormat.totalEvents} event results.`);
  }
  if (parsed.some((match) => match.date !== first.date
    || match.homeSchoolId !== first.homeSchoolId
    || match.opponentSchoolId !== first.opponentSchoolId)) {
    throw new Error("Every event must use the same date, home school, and opponent school.");
  }
  const positions = new Set(parsed.map((match) => match.position));
  if (positions.size !== seasonFormat.totalEvents
    || seasonFormat.eventOrder.some((position) => !positions.has(position))) {
    throw new Error(`The meet must contain every saved ${first.year} position exactly once.`);
  }

  const usedPlayers = new Set<string>();
  const singlesRanks = new Map<"BS" | "GS", Array<{ position: EventCode; rank: number }>>([
    ["BS", []],
    ["GS", []],
  ]);
  for (const match of parsed) {
    const firstPlayer = match.player1Info;
    const secondPlayer = match.player2Info;
    const pairEvent = match.position.startsWith("BD") || match.position.startsWith("GD") || match.position.startsWith("XD");
    if (!pairEvent && secondPlayer) throw new Error(`${match.position} is a singles event and must have only one player.`);
    const expectedFirstGender = match.position.startsWith("GS") || match.position.startsWith("GD") ? "Girls" : "Boys";
    const expectedSecondGender = match.position.startsWith("GD") || match.position.startsWith("XD") ? "Girls" : "Boys";
    if (firstPlayer.gender !== expectedFirstGender) throw new Error(`${firstPlayer.name} is not eligible for ${match.position}.`);
    if (secondPlayer && secondPlayer.gender !== expectedSecondGender) throw new Error(`${secondPlayer.name} is not eligible for ${match.position}.`);
    if (match.position.startsWith("BS") || match.position.startsWith("GS")) {
      const prefix = match.position.slice(0, 2) as "BS" | "GS";
      singlesRanks.get(prefix)?.push({
        position: match.position,
        rank: firstPlayer.rank,
      });
    }
    for (const player of [firstPlayer, secondPlayer]) {
      if (!player) continue;
      if (usedPlayers.has(player.id)) throw new Error(`${player.name} appears more than once in the meet.`);
      usedPlayers.add(player.id);
    }
  }
  for (const [prefix, entries] of singlesRanks) {
    entries.sort((a, b) => Number(a.position.slice(2)) - Number(b.position.slice(2)));
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].rank >= entries[index].rank) {
        throw new Error(`${prefix} positions must follow the ${first.year} ladder order.`);
      }
    }
  }

  const existing = await db().prepare(
     `SELECT COUNT(*) AS count FROM match_events
     WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ? AND match_date = ?`,
  ).bind(account.id, first.homeSchoolId, first.opponentSchoolId, first.date).first<{ count: number }>();
  if (Number(existing?.count ?? 0) > 0) {
    throw new Error("Results for this opponent and date already exist. Change the date or use a different opponent.");
  }
}

async function ratingSnapshot(account: AccountContext, parsed: ParsedMatch[]): Promise<RatingSnapshot> {
  const first = parsed[0];
  const seasonFormat = first.seasonFormat;
  const uniqueCodes = [...new Set(parsed.flatMap((match) => [match.player1, match.player2].filter(Boolean) as string[]))];
  const playerMap = new Map<string, { code: string; name: string; elo: number }>();
  const playerRows = await db().prepare(
    "SELECT * FROM players WHERE account_id = ? AND school_id = ?",
  ).bind(account.id, first.homeSchoolId).all<DbPlayer>();
  const byCode = new Map(playerRows.results.map((player) => [player.player_code.toLowerCase(), player]));
  for (const code of uniqueCodes) {
    const player = byCode.get(code.toLowerCase());
    if (!player) throw new Error(`Could not find player ${code}.`);
    playerMap.set(player.player_code.toLowerCase(), {
      code: player.player_code,
      name: player.display_name,
      elo: Number(player.current_elo),
    });
  }

  const rows = await db().prepare(
     `SELECT position, current_elo FROM opponent_positions
     WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
  ).bind(account.id, first.homeSchoolId, first.opponentSchoolId).all<{ position: EventCode; current_elo: number }>();
  const calibration = await db().prepare(
     `SELECT elo_offset FROM opponent_calibrations
     WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
  ).bind(account.id, first.homeSchoolId, first.opponentSchoolId).first<{ elo_offset: number }>();
  const offset = Number(calibration?.elo_offset ?? 0);
  const raw = new Map(rows.results.map((row) => [row.position, Number(row.current_elo)]));
  return {
    players: playerMap,
    positions: new Map(seasonFormat.eventOrder.map((position) => [
      position,
      (raw.get(position) ?? defaultPositionElo(position)) + offset,
    ])),
  };
}

async function receiptFromSnapshots(
  account: AccountContext,
  parsed: ParsedMatch[],
  before: RatingSnapshot,
  after: RatingSnapshot,
  exact: boolean,
): Promise<MeetRatingReceipt> {
  const first = parsed[0];
  const seasonFormat = first.seasonFormat;
  const schoolRows = await db().prepare("SELECT id, name FROM schools WHERE account_id = ? AND id IN (?, ?)")
    .bind(account.id, first.homeSchoolId, first.opponentSchoolId).all<{ id: string; name: string }>();
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
    positionChanges: seasonFormat.eventOrder.map((position) => {
      const oldElo = before.positions.get(position) ?? defaultPositionElo(position);
      const newElo = after.positions.get(position) ?? defaultPositionElo(position);
      return { position, oldElo, change: newElo - oldElo, newElo };
    }),
  };
}

async function estimatedMeetReceipt(account: AccountContext, parsed: ParsedMatch[]) {
  const before = await ratingSnapshot(account, parsed);
  const after: RatingSnapshot = {
    players: new Map([...before.players].map(([code, player]) => [code, { ...player }])),
    positions: new Map(before.positions),
  };
  const first = parsed[0];
  const yearRows = await db().prepare(
    "SELECT DISTINCT season_year AS year FROM match_events WHERE account_id = ? AND home_school_id = ? ORDER BY season_year",
  ).bind(account.id, first.homeSchoolId).all<{ year: number }>();
  const activeYears = [...new Set([...yearRows.results.map((row) => Number(row.year)), first.year])]
    .sort((a, b) => a - b).slice(-POSITION_SEASON_WINDOW);
  const yearWeight = Math.max(1, activeYears.indexOf(first.year) + 1);
  const positionRows = await db().prepare(
     `SELECT position, current_elo, total_weight FROM opponent_positions
     WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
  ).bind(account.id, first.homeSchoolId, first.opponentSchoolId).all<{ position: EventCode; current_elo: number; total_weight: number }>();
  const calibration = await db().prepare(
     `SELECT elo_offset FROM opponent_calibrations
     WHERE account_id = ? AND home_school_id = ? AND opponent_school_id = ?`,
  ).bind(account.id, first.homeSchoolId, first.opponentSchoolId).first<{ elo_offset: number }>();
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
  return receiptFromSnapshots(account, parsed, before, after, false);
}

export async function previewMeet(account: AccountContext, rows: CsvRow[]) {
  await ensureSchema();
  await ensureCurrentRatingModel(account.id);
  const parsed = await parseMatchRows(account, rows, false);
  await validateCompleteMeet(account, parsed);
  return estimatedMeetReceipt(account, parsed);
}

export async function confirmMeet(account: AccountContext, rows: CsvRow[]) {
  await ensureSchema();
  await ensureCurrentRatingModel(account.id);
  const parsed = await parseMatchRows(account, rows, false);
  await validateCompleteMeet(account, parsed);
  const before = await ratingSnapshot(account, parsed);
  const imported = await insertParsedMatches(account, parsed);
  const seasonFormat = parsed[0].seasonFormat;
  if (imported.inserted !== seasonFormat.totalEvents) {
    throw new Error("The complete meet could not be saved. No duplicate events are allowed.");
  }
  const after = await ratingSnapshot(account, parsed);
  return { ...imported, receipt: await receiptFromSnapshots(account, parsed, before, after, true) };
}

export async function importMatches(account: AccountContext, rows: CsvRow[]) {
  await ensureSchema();
  const parsed = await parseMatchRows(account, rows, true);
  return insertParsedMatches(account, parsed);
}

async function insertParsedMatches(account: AccountContext, parsed: ParsedMatch[]) {
  const eventPayload = parsed.map((match) => ({
    id: `${match.homeSchoolId}|${match.opponentSchoolId}|${match.date}|${match.position}`,
    date: match.date,
    year: match.year,
    homeSchoolId: match.homeSchoolId,
    opponentSchoolId: match.opponentSchoolId,
    position: match.position,
    player1: match.player1,
    player2: match.player2,
    scores: JSON.stringify(match.games),
    pointDifferential: match.pointDifferential,
    homeWon: match.homeWon ? 1 : 0,
  }));
  const result = await db().prepare(
    `INSERT OR IGNORE INTO match_events
     (id, account_id, match_date, season_year, season_weight, home_school_id, opponent_school_id,
      position, home_player_1_code, home_player_2_code, scores_json, point_differential, home_won)
     SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.date'),
      json_extract(value, '$.year'), 1, json_extract(value, '$.homeSchoolId'),
      json_extract(value, '$.opponentSchoolId'), json_extract(value, '$.position'),
      json_extract(value, '$.player1'), json_extract(value, '$.player2'),
      json_extract(value, '$.scores'), json_extract(value, '$.pointDifferential'),
      json_extract(value, '$.homeWon') FROM json_each(?)`,
  ).bind(account.id, jsonRows(eventPayload)).run();
  const inserted = Number(result.meta.changes ?? 0);
  const duplicates = parsed.length - inserted;

  await recomputeRatings(account.id);
  return { inserted, duplicates, yearsReweighted: true };
}

async function recomputeRatings(accountId: string) {
  type EventRow = {
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
  };
  const [eventResult, playerResult, aliasResult, playerSeasonResult] = await db().batch([
    db().prepare(
      `SELECT * FROM match_events WHERE account_id = ?
       ORDER BY match_date, home_school_id, opponent_school_id, position`,
    ).bind(accountId),
    db().prepare("SELECT * FROM players WHERE account_id = ?").bind(accountId),
    db().prepare("SELECT school_id, alias_code, player_id FROM player_aliases WHERE account_id = ?").bind(accountId),
    db().prepare(
      `SELECT player_id, school_id, season, rank, initialized_elo
       FROM player_seasons WHERE account_id = ? ORDER BY school_id, season, player_id`,
    ).bind(accountId),
  ]);
  const events = (eventResult.results ?? []) as EventRow[];
  const players = (playerResult.results ?? []) as DbPlayer[];
  const aliases = (aliasResult.results ?? []) as Array<{ school_id: string; alias_code: string; player_id: string }>;
  const playerSeasons = (playerSeasonResult.results ?? []) as DbPlayerSeason[];

  const playerStates = new Map(players.map((player) => [player.id, {
    ...player,
    current_elo: Number(player.initial_elo),
  }]));
  const playerByAlias = new Map<string, DbPlayer>();
  for (const player of playerStates.values()) {
    playerByAlias.set(`${player.school_id}|${player.player_code.toLowerCase()}`, player);
  }
  for (const alias of aliases) {
    const player = playerStates.get(alias.player_id);
    if (player) playerByAlias.set(`${alias.school_id}|${alias.alias_code.toLowerCase()}`, player);
  }

  const floorsBySchool = new Map<string, DbPlayerSeason[]>();
  for (const row of playerSeasons) {
    const rows = floorsBySchool.get(row.school_id) ?? [];
    rows.push(row);
    floorsBySchool.set(row.school_id, rows);
  }
  const appliedFloors = new Set<string>();
  const applyFloorsThrough = (schoolId: string, season: number) => {
    for (const row of floorsBySchool.get(schoolId) ?? []) {
      const key = `${row.player_id}:${row.season}`;
      if (Number(row.season) > season || appliedFloors.has(key)) continue;
      const player = playerStates.get(row.player_id);
      if (player && Number(player.current_elo) < Number(row.initialized_elo)) {
        player.current_elo = Number(row.initialized_elo);
      }
      appliedFloors.add(key);
    }
  };

  const yearsBySchool = new Map<string, number[]>();
  for (const event of events) {
    const years = yearsBySchool.get(event.home_school_id) ?? [];
    if (!years.includes(Number(event.season_year))) years.push(Number(event.season_year));
    yearsBySchool.set(event.home_school_id, years);
  }
  for (const [schoolId, years] of yearsBySchool) {
    years.sort((a, b) => a - b);
    yearsBySchool.set(schoolId, years.slice(-POSITION_SEASON_WINDOW));
  }

  const positionStates = new Map<string, {
    id: string;
    homeSchoolId: string;
    opponentSchoolId: string;
    position: EventCode;
    elo: number;
    weight: number;
    matches: number;
  }>();
  const eventWeights: Array<{ id: string; weight: number }> = [];

  for (const event of events) {
    applyFloorsThrough(event.home_school_id, Number(event.season_year));
    const activeYears = yearsBySchool.get(event.home_school_id) ?? [];
    const activeYearIndex = activeYears.indexOf(Number(event.season_year));
    const yearWeight = activeYearIndex >= 0 ? activeYearIndex + 1 : 0;
    event.season_weight = yearWeight;
    eventWeights.push({ id: event.id, weight: yearWeight });
    const player1 = playerByAlias.get(`${event.home_school_id}|${event.home_player_1_code.toLowerCase()}`);
    const player2 = event.home_player_2_code
      ? playerByAlias.get(`${event.home_school_id}|${event.home_player_2_code.toLowerCase()}`) ?? null
      : null;
    if (!player1 || (event.home_player_2_code && !player2)) continue;

    const homeElo = Number(player1.current_elo) + Number(player2?.current_elo ?? 0);
    const positionId = `${event.home_school_id}|${event.opponent_school_id}|${event.position}`;
    const old = yearWeight > 0 ? positionStates.get(positionId) : null;
    const observation = homeElo - POINT_SCALE * Number(event.point_differential);
    const oldWeight = Number(old?.weight ?? 0);
    const newWeight = oldWeight + yearWeight;
    const newOpponentElo = yearWeight > 0 && oldWeight > 0
      ? (Number(old?.elo) * oldWeight + observation * yearWeight) / newWeight
      : observation;
    const expected = eloWinProbability(homeElo, oldWeight > 0 ? Number(old?.elo) : observation);
    const margin = Math.abs(Number(event.point_differential));
    const eventChange = homePlayerEloChange(
      margin,
      event.home_won ? 1 : 0,
      expected,
    );
    const playerChange = eventChange / (player2 ? 2 : 1);

    player1.current_elo = Number(player1.current_elo) + playerChange;
    if (player2) player2.current_elo = Number(player2.current_elo) + playerChange;
    if (yearWeight > 0) {
      positionStates.set(positionId, {
        id: positionId,
        homeSchoolId: event.home_school_id,
        opponentSchoolId: event.opponent_school_id,
        position: event.position,
        elo: newOpponentElo,
        weight: newWeight,
        matches: Number(old?.matches ?? 0) + 1,
      });
    }
  }

  for (const [schoolId, rows] of floorsBySchool) {
    const latestSeason = Math.max(...rows.map((row) => Number(row.season)));
    applyFloorsThrough(schoolId, latestSeason);
  }

  const finalPlayerElo = new Map(
    [...playerStates.values()].map((row) => [
      `${row.school_id}|${row.player_code.toLowerCase()}`,
      Number(row.current_elo),
    ]),
  );
  const finalPositionElo = new Map(
    [...positionStates.values()].map((row) => [
      `${row.homeSchoolId}|${row.opponentSchoolId}|${row.position}`,
      Number(row.elo),
    ]),
  );
  const calibrationGroups = new Map<string, {
    homeSchoolId: string;
    opponentSchoolId: string;
    actualWins: number;
    dates: Set<string>;
    samples: Array<{ homeElo: number; opponentElo: number }>;
  }>();
  for (const event of events) {
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
  const calibrations: Array<{
    id: string;
    homeSchoolId: string;
    opponentSchoolId: string;
    offset: number;
    actualWins: number;
    projectedWins: number;
    eventCount: number;
    meetCount: number;
  }> = [];
  for (const [id, group] of calibrationGroups) {
    const targetWins = smoothedHistoricalWins(group.actualWins, group.samples.length);
    const offset = fitOpponentEloOffset(group.samples, targetWins);
    const projectedWins = group.samples.reduce(
      (sum, sample) => sum + eloWinProbability(sample.homeElo, sample.opponentElo + offset),
      0,
    );
    calibrations.push({
      id,
      homeSchoolId: group.homeSchoolId,
      opponentSchoolId: group.opponentSchoolId,
      offset,
      actualWins: group.actualWins,
      projectedWins,
      eventCount: group.samples.length,
      meetCount: group.dates.size,
    });
  }

  const playerUpdates = [...playerStates.values()].map((player) => ({
    id: player.id,
    elo: Number(player.current_elo),
  }));
  const positionWrites = [...positionStates.values()];
  await db().batch([
    db().prepare(
      `WITH incoming AS (
         SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.elo') AS elo
         FROM json_each(?)
       )
       UPDATE players SET current_elo = (SELECT elo FROM incoming WHERE incoming.id = players.id)
       WHERE account_id = ? AND id IN (SELECT id FROM incoming)`,
    ).bind(jsonRows(playerUpdates), accountId),
    db().prepare(
      `WITH incoming AS (
         SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.weight') AS weight
         FROM json_each(?)
       )
       UPDATE match_events SET season_weight = (SELECT weight FROM incoming WHERE incoming.id = match_events.id)
       WHERE account_id = ? AND id IN (SELECT id FROM incoming)`,
    ).bind(jsonRows(eventWeights), accountId),
    db().prepare("DELETE FROM opponent_positions WHERE account_id = ?").bind(accountId),
    db().prepare(
      `INSERT INTO opponent_positions
       (id, account_id, home_school_id, opponent_school_id, position, current_elo, total_weight, matches_used)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.homeSchoolId'),
        json_extract(value, '$.opponentSchoolId'), json_extract(value, '$.position'),
        json_extract(value, '$.elo'), json_extract(value, '$.weight'),
        json_extract(value, '$.matches') FROM json_each(?)`,
    ).bind(accountId, jsonRows(positionWrites)),
    db().prepare("DELETE FROM opponent_calibrations WHERE account_id = ?").bind(accountId),
    db().prepare(
      `INSERT INTO opponent_calibrations
       (id, account_id, home_school_id, opponent_school_id, elo_offset, actual_wins,
        projected_wins, event_count, meet_count)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.homeSchoolId'),
        json_extract(value, '$.opponentSchoolId'), json_extract(value, '$.offset'),
        json_extract(value, '$.actualWins'), json_extract(value, '$.projectedWins'),
        json_extract(value, '$.eventCount'), json_extract(value, '$.meetCount') FROM json_each(?)`,
    ).bind(accountId, jsonRows(calibrations)),
    db().prepare(
      `INSERT INTO model_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(metadataKey(accountId, "rating_model_version"), RATING_MODEL_VERSION),
  ]);
}

const ratingModelReady = new Set<string>();

async function ensureCurrentRatingModel(accountId: string) {
  if (ratingModelReady.has(accountId)) return;
  const stored = await db().prepare(
    "SELECT value FROM model_metadata WHERE key = ?",
  ).bind(metadataKey(accountId, "rating_model_version")).first<{ value: string }>();

  if (stored?.value !== RATING_MODEL_VERSION) {
    const matchCount = await db().prepare(
      "SELECT COUNT(*) AS count FROM match_events WHERE account_id = ?",
    ).bind(accountId).first<{ count: number }>();
    if (Number(matchCount?.count ?? 0) > 0) {
      await recomputeRatings(accountId);
    } else {
      await db().prepare(
        `INSERT INTO model_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).bind(metadataKey(accountId, "rating_model_version"), RATING_MODEL_VERSION).run();
    }
  }
  ratingModelReady.add(accountId);
}
