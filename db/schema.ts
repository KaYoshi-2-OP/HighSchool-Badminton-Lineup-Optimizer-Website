import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  normalizedUsername: text("normalized_username").notNull(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordIterations: integer("password_iterations").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("accounts_username_unique").on(table.normalizedUsername)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("sessions_account_idx").on(table.accountId),
  index("sessions_expires_idx").on(table.expiresAt),
]);

export const loginAttempts = sqliteTable("login_attempts", {
  normalizedUsername: text("normalized_username").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  windowStartedAt: text("window_started_at").notNull(),
  lockedUntil: text("locked_until"),
});

export const schools = sqliteTable("schools", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("schools_account_name_unique").on(table.accountId, table.name),
  index("schools_account_idx").on(table.accountId),
]);

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  schoolId: text("school_id").notNull(),
  playerCode: text("player_code").notNull(),
  displayName: text("display_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  gender: text("gender").notNull(),
  rank: integer("rank").notNull(),
  initialElo: real("initial_elo").notNull(),
  currentElo: real("current_elo").notNull(),
  firstSeason: integer("first_season").notNull(),
  lastSeason: integer("last_season").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => [
  uniqueIndex("players_school_code_unique").on(table.schoolId, table.playerCode),
  index("players_school_active_idx").on(table.schoolId, table.active),
]);

export const playerAliases = sqliteTable("player_aliases", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  schoolId: text("school_id").notNull(),
  aliasCode: text("alias_code").notNull(),
  playerId: text("player_id").notNull(),
}, (table) => [
  uniqueIndex("player_alias_school_code_unique").on(table.schoolId, table.aliasCode),
  index("player_alias_player_idx").on(table.playerId),
]);

export const matchEvents = sqliteTable("match_events", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  matchDate: text("match_date").notNull(),
  seasonYear: integer("season_year").notNull(),
  seasonWeight: integer("season_weight").notNull().default(1),
  homeSchoolId: text("home_school_id").notNull(),
  opponentSchoolId: text("opponent_school_id").notNull(),
  position: text("position").notNull(),
  homePlayer1Code: text("home_player_1_code").notNull(),
  homePlayer2Code: text("home_player_2_code"),
  scoresJson: text("scores_json").notNull(),
  pointDifferential: integer("point_differential").notNull(),
  homeWon: integer("home_won", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("match_event_unique").on(
    table.homeSchoolId,
    table.opponentSchoolId,
    table.matchDate,
    table.position,
  ),
  index("match_events_home_date_idx").on(table.homeSchoolId, table.matchDate),
]);

export const opponentPositions = sqliteTable("opponent_positions", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  homeSchoolId: text("home_school_id").notNull(),
  opponentSchoolId: text("opponent_school_id").notNull(),
  position: text("position").notNull(),
  currentElo: real("current_elo").notNull(),
  totalWeight: real("total_weight").notNull(),
  matchesUsed: integer("matches_used").notNull(),
}, (table) => [
  uniqueIndex("opponent_position_unique").on(
    table.homeSchoolId,
    table.opponentSchoolId,
    table.position,
  ),
]);

export const modelMetadata = sqliteTable("model_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const playerSeasons = sqliteTable("player_seasons", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  playerId: text("player_id").notNull(),
  schoolId: text("school_id").notNull(),
  season: integer("season").notNull(),
  rank: integer("rank").notNull(),
  initializedElo: real("initialized_elo").notNull(),
}, (table) => [
  uniqueIndex("player_season_unique").on(table.playerId, table.season),
  index("player_seasons_school_season_idx").on(table.schoolId, table.season),
]);

export const opponentCalibrations = sqliteTable("opponent_calibrations", {
  id: text("id").primaryKey(),
  accountId: text("account_id"),
  homeSchoolId: text("home_school_id").notNull(),
  opponentSchoolId: text("opponent_school_id").notNull(),
  eloOffset: real("elo_offset").notNull(),
  actualWins: real("actual_wins").notNull(),
  projectedWins: real("projected_wins").notNull(),
  eventCount: integer("event_count").notNull(),
  meetCount: integer("meet_count").notNull(),
}, (table) => [
  uniqueIndex("opponent_calibration_unique").on(table.homeSchoolId, table.opponentSchoolId),
]);
