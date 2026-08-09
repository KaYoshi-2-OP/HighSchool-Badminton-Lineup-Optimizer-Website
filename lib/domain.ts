export const EVENT_ORDER = [
  "BS1", "BS2", "BS3", "BS4",
  "GS1", "GS2", "GS3", "GS4",
  "BD1", "BD2", "BD3",
  "GD1", "GD2", "GD3",
  "XD1", "XD2", "XD3",
] as const;

export type EventCode = (typeof EVENT_ORDER)[number];
export type Gender = "Boys" | "Girls";

export const HOME_K_FACTOR = 2;
export const CALIBRATION_OFFSET_LIMIT = 800;

export type PlayerRecord = {
  id: string;
  schoolId: string;
  playerCode: string;
  displayName: string;
  gender: Gender;
  rank: number;
  initialElo: number;
  currentElo: number;
  firstSeason: number;
  lastSeason: number;
  active: boolean;
};

export type PositionRating = {
  position: EventCode;
  currentElo: number;
  totalWeight: number;
  matchesUsed: number;
};

export function normalizeGender(value: string): Gender {
  const normalized = value.trim().toLowerCase();
  if (["b", "boy", "boys", "m", "male"].includes(normalized)) return "Boys";
  if (["g", "girl", "girls", "f", "female"].includes(normalized)) return "Girls";
  throw new Error(`Unrecognized gender: ${value}`);
}

export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function schoolIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error("School name cannot be blank.");
  return slug;
}

export function preseasonElo(rank: number, ladderSize: number): number {
  if (ladderSize <= 1) return 2200;
  return Math.round(
    1000 + 1200 * Math.pow((ladderSize - rank) / (ladderSize - 1), 1.8),
  );
}

export function eloWinProbability(selfElo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - selfElo) / 400));
}

export function homePlayerEloChange(
  pointDifferential: number,
  actual: 0 | 1,
  expected: number,
): number {
  return HOME_K_FACTOR * Math.abs(pointDifferential) * (actual - expected);
}

export function smoothedHistoricalWins(actualWins: number, eventCount: number): number {
  if (eventCount <= 0) return 0;
  return eventCount * (actualWins + 0.5) / (eventCount + 1);
}

export function fitOpponentEloOffset(
  samples: Array<{ homeElo: number; opponentElo: number }>,
  targetWins: number,
): number {
  if (!samples.length) return 0;
  let low = -CALIBRATION_OFFSET_LIMIT;
  let high = CALIBRATION_OFFSET_LIMIT;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const middle = (low + high) / 2;
    const projected = samples.reduce(
      (sum, sample) => sum + eloWinProbability(sample.homeElo, sample.opponentElo + middle),
      0,
    );
    if (projected > targetWins) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function defaultPositionElo(position: EventCode): number {
  if (position.startsWith("BS") || position.startsWith("GS")) return 1600;
  return 3200;
}

export function isEventCode(value: string): value is EventCode {
  return (EVENT_ORDER as readonly string[]).includes(value);
}
