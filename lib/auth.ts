import { env } from "cloudflare:workers";
import { initializeAccountWorkspace, type AccountContext } from "./server-store";

const PBKDF2_ITERATIONS = 100_000;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const SECURE_COOKIE = "__Host-badminton_session";
const LOCAL_COOKIE = "badminton_session";

type AccountRow = {
  id: string;
  username: string;
  normalized_username: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

function db() {
  if (!env.DB) throw new Error("Persistent database binding is unavailable.");
  return env.DB;
}

let authSchemaReady = false;

async function ensureAuthSchema() {
  if (authSchemaReady) return;
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
  ]);
  authSchemaReady = true;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validateUsername(value: string): string {
  const username = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,29}$/.test(username)) {
    throw new AuthError("Username must be 3–30 characters and use only letters, numbers, underscores, or hyphens.");
  }
  return username;
}

function validatePassword(value: string): string {
  if (value.length < 8) throw new AuthError("Password must contain at least 8 characters.");
  if (value.length > 128) throw new AuthError("Password must contain no more than 128 characters.");
  return value;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(first: Uint8Array, second: Uint8Array): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference |= first[index] ^ second[index];
  return difference === 0;
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const values = new Map(cookieHeader.split(";").map((part) => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator).trim(), separator >= 0 ? part.slice(separator + 1).trim() : ""];
  }));
  return values.get(SECURE_COOKIE) ?? values.get(LOCAL_COOKIE) ?? null;
}

function cookieName(requestUrl: string): string {
  return new URL(requestUrl).protocol === "https:" ? SECURE_COOKIE : LOCAL_COOKIE;
}

export function sessionCookie(token: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:";
  return `${cookieName(requestUrl)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookies(): string[] {
  return [
    `${SECURE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    `${LOCAL_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ];
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new AuthError("Cross-site request rejected.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AuthError("Cross-site request rejected.", 403);
}

async function createSession(accountId: string): Promise<string> {
  const token = bytesToBase64Url(randomBytes(32));
  const id = await tokenHash(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db().batch([
    db().prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()),
    db().prepare("INSERT INTO sessions (id, account_id, expires_at) VALUES (?, ?, ?)").bind(id, accountId, expiresAt),
  ]);
  return token;
}

async function currentLock(normalizedUsername: string): Promise<Date | null> {
  const attempt = await db().prepare(
    "SELECT locked_until FROM login_attempts WHERE normalized_username = ?",
  ).bind(normalizedUsername).first<{ locked_until: string | null }>();
  if (!attempt?.locked_until) return null;
  const lockedUntil = new Date(attempt.locked_until);
  return lockedUntil.valueOf() > Date.now() ? lockedUntil : null;
}

async function recordFailedLogin(normalizedUsername: string) {
  const now = new Date();
  const existing = await db().prepare(
    "SELECT failed_count, window_started_at FROM login_attempts WHERE normalized_username = ?",
  ).bind(normalizedUsername).first<{ failed_count: number; window_started_at: string }>();
  const withinWindow = existing && now.valueOf() - new Date(existing.window_started_at).valueOf() <= LOGIN_WINDOW_MS;
  const failedCount = withinWindow ? Number(existing.failed_count) + 1 : 1;
  const windowStartedAt = withinWindow ? existing.window_started_at : now.toISOString();
  const lockedUntil = failedCount >= MAX_FAILED_LOGINS
    ? new Date(now.valueOf() + LOGIN_LOCK_MS).toISOString()
    : null;
  await db().prepare(
    `INSERT INTO login_attempts (normalized_username, failed_count, window_started_at, locked_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(normalized_username) DO UPDATE SET
       failed_count = excluded.failed_count,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until`,
  ).bind(normalizedUsername, failedCount, windowStartedAt, lockedUntil).run();
}

export async function registerAccount(usernameValue: string, passwordValue: string) {
  await ensureAuthSchema();
  const username = validateUsername(usernameValue);
  const normalizedUsername = normalizeUsername(username);
  const password = validatePassword(passwordValue);
  const existing = await db().prepare(
    "SELECT id FROM accounts WHERE normalized_username = ?",
  ).bind(normalizedUsername).first<{ id: string }>();
  if (existing) throw new AuthError("That username is unavailable.", 409);

  const accountCount = await db().prepare("SELECT COUNT(*) AS count FROM accounts")
    .first<{ count: number }>();
  const id = `acct_${crypto.randomUUID().replaceAll("-", "")}`;
  const salt = randomBytes(16);
  const passwordHash = await derivePassword(password, salt, PBKDF2_ITERATIONS);
  await db().prepare(
    `INSERT INTO accounts
     (id, username, normalized_username, password_hash, password_salt, password_iterations)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    username,
    normalizedUsername,
    bytesToBase64Url(passwordHash),
    bytesToBase64Url(salt),
    PBKDF2_ITERATIONS,
  ).run();

  try {
    await initializeAccountWorkspace(id, Number(accountCount?.count ?? 0) === 0);
  } catch (error) {
    await db().prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
    throw error;
  }

  return {
    account: { id, username } satisfies AccountContext,
    token: await createSession(id),
  };
}

export async function loginAccount(usernameValue: string, passwordValue: string) {
  await ensureAuthSchema();
  const normalizedUsername = normalizeUsername(usernameValue);
  if (!normalizedUsername) throw new AuthError("Invalid username or password.", 401);
  const lockedUntil = await currentLock(normalizedUsername);
  if (lockedUntil) throw new AuthError("Too many failed attempts. Try again in 15 minutes.", 429);

  const account = await db().prepare(
    "SELECT * FROM accounts WHERE normalized_username = ?",
  ).bind(normalizedUsername).first<AccountRow>();
  const password = passwordValue.slice(0, 128);
  const suppliedHash = account
    ? await derivePassword(password, base64UrlToBytes(account.password_salt), Number(account.password_iterations))
    : await derivePassword(password, new Uint8Array(16), PBKDF2_ITERATIONS);
  const valid = account
    ? constantTimeEqual(suppliedHash, base64UrlToBytes(account.password_hash))
    : false;
  if (!account || !valid) {
    await recordFailedLogin(normalizedUsername);
    throw new AuthError("Invalid username or password.", 401);
  }

  await db().prepare("DELETE FROM login_attempts WHERE normalized_username = ?")
    .bind(normalizedUsername).run();
  return {
    account: { id: account.id, username: account.username } satisfies AccountContext,
    token: await createSession(account.id),
  };
}

export async function getAccountFromCookieHeader(cookieHeader: string | null): Promise<AccountContext | null> {
  await ensureAuthSchema();
  const token = readCookie(cookieHeader);
  if (!token || token.length > 100) return null;
  const id = await tokenHash(token);
  const row = await db().prepare(
    `SELECT a.id, a.username FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.id = ? AND s.expires_at > ?`,
  ).bind(id, new Date().toISOString()).first<{ id: string; username: string }>();
  return row ? { id: row.id, username: row.username } : null;
}

export async function deleteSession(cookieHeader: string | null) {
  await ensureAuthSchema();
  const token = readCookie(cookieHeader);
  if (!token || token.length > 100) return;
  await db().prepare("DELETE FROM sessions WHERE id = ?").bind(await tokenHash(token)).run();
}
