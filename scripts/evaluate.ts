import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  EVENT_ORDER,
  type EventCode,
  type Gender,
  type PlayerRecord,
  type PositionRating,
  defaultPositionElo,
  eloWinProbability,
  fitOpponentEloOffset,
  homePlayerEloChange,
  makeSeasonFormat,
  preseasonElo,
  smoothedHistoricalWins,
} from "../lib/domain.ts";
import { optimizeLineup } from "../lib/optimizer.ts";

type CsvRow = Record<string, string>;

type MatchRow = {
  date: string;
  season: number;
  opponent: string;
  position: EventCode;
  player1: string;
  player2: string | null;
  differential: number;
  outcome: 0 | 1;
};

type RosterRow = {
  season: number;
  playerId: string;
  name: string;
  gender: Gender;
  rank: number;
  ladderSize: number;
};

type PlayerState = {
  elo: number;
  lastFloorSeason: number;
};

type PositionState = {
  elo: number;
  totalWeight: number;
};

type CalibrationSample = {
  homeElo: number;
  opponentElo: number;
  outcome: 0 | 1;
};

type PredictionRow = {
  date: string;
  opponent: string;
  position: EventCode;
  probability: number;
  outcome: 0 | 1;
  rollingOverall: number;
  rollingPosition: number;
};

type MeetPrediction = {
  date: string;
  opponent: string;
  actualWins: number;
  expectedWins: number;
  optimizedWins: number;
  meetProbability: number;
};

type EvaluationOptions = {
  impute: boolean;
  excludeEmerald: boolean;
  excludeRepeatedGroups: boolean;
  runOptimizer: boolean;
  eventOrder: "file" | "event" | "lexicographic";
  strictTrainingMissing: "skip-event" | "skip-meet";
};

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [headers, ...body] = rows.filter((values) => values.some((value) => value !== ""));
  return body.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function readCsv(filePath: string): CsvRow[] {
  return parseCsv(fs.readFileSync(filePath, "utf8"));
}

function normalizeGender(value: string): Gender {
  return value.toLowerCase().startsWith("b") ? "Boys" : "Girls";
}

function loadRosters(filePath: string): RosterRow[] {
  return readCsv(filePath).map((row) => ({
    season: Number(row.season),
    playerId: row.player_id,
    name: row.name,
    gender: normalizeGender(row.gender),
    rank: Number(row.rank),
    ladderSize: Number(row.ladder_size),
  }));
}

function loadMatches(filePath: string): MatchRow[] {
  return readCsv(filePath).map((row) => {
    const games: Array<[number, number]> = [];
    for (let game = 1; game <= 3; game += 1) {
      if (!row[`g${game}_home`] && !row[`g${game}_opponent`]) continue;
      games.push([Number(row[`g${game}_home`]), Number(row[`g${game}_opponent`])]);
    }
    const gameWins = games.filter(([home, opponent]) => home > opponent).length;
    return {
      date: row.date,
      season: Number(row.date.slice(0, 4)),
      opponent: row.opponent_school,
      position: row.position as EventCode,
      player1: row.home_player_1,
      player2: row.home_player_2 || null,
      differential: games.reduce((total, [home, opponent]) => total + home - opponent, 0),
      outcome: gameWins === 2 ? 1 : 0,
    };
  });
}

function imputeRosters(rosters: RosterRow[], missing: CsvRow[]): RosterRow[] {
  const result = rosters.map((row) => ({ ...row }));
  const byPlayer = new Map<string, RosterRow[]>();
  for (const row of rosters) {
    const rows = byPlayer.get(row.playerId) ?? [];
    rows.push(row);
    byPlayer.set(row.playerId, rows);
  }
  const missingGroups = new Map<string, Array<{ season: number; playerId: string; source: RosterRow }>>();
  for (const row of missing) {
    const season = Number(row.season);
    const playerId = row.player_id;
    const candidates = byPlayer.get(playerId) ?? [];
    const source = [...candidates].sort((a, b) => {
      const distance = Math.abs(a.season - season) - Math.abs(b.season - season);
      return distance || a.season - b.season;
    })[0];
    if (!source) throw new Error(`No roster identity is available for ${season} ${playerId}.`);
    const key = `${season}|${source.gender}`;
    const rows = missingGroups.get(key) ?? [];
    rows.push({ season, playerId, source });
    missingGroups.set(key, rows);
  }
  for (const [key, additions] of missingGroups) {
    const [seasonText, genderText] = key.split("|");
    const season = Number(seasonText);
    const gender = genderText as Gender;
    const existing = result.filter((row) => row.season === season && row.gender === gender);
    const baseSize = Math.max(...existing.flatMap((row) => [row.rank, row.ladderSize]));
    const expandedSize = baseSize + additions.length;
    for (const row of existing) row.ladderSize = expandedSize;
    additions.sort((a, b) => a.playerId.localeCompare(b.playerId));
    additions.forEach((addition, index) => {
      result.push({
        season,
        playerId: addition.playerId,
        name: addition.source.name,
        gender,
        rank: baseSize + index + 1,
        ladderSize: expandedSize,
      });
    });
  }
  return result;
}

function groupMatches(matches: MatchRow[]) {
  const groups = new Map<string, MatchRow[]>();
  for (const match of matches) {
    const key = `${match.date}|${match.opponent}`;
    const rows = groups.get(key) ?? [];
    rows.push(match);
    groups.set(key, rows);
  }
  return [...groups.values()].sort((a, b) => a[0].date.localeCompare(b[0].date) || a[0].opponent.localeCompare(b[0].opponent));
}

function isComplete(rows: MatchRow[]): boolean {
  return rows.length === EVENT_ORDER.length
    && EVENT_ORDER.every((position) => rows.some((row) => row.position === position));
}

function hasRepeatedPlayer(rows: MatchRow[]): boolean {
  const players = rows.flatMap((row) => [row.player1, row.player2].filter(Boolean) as string[]);
  return new Set(players).size !== players.length;
}

function poissonBinomialMeetWin(probabilities: number[]): number {
  const distribution = Array(probabilities.length + 1).fill(0) as number[];
  distribution[0] = 1;
  for (const probability of probabilities) {
    for (let wins = probabilities.length; wins >= 0; wins -= 1) {
      distribution[wins] = distribution[wins] * (1 - probability)
        + (wins > 0 ? distribution[wins - 1] * probability : 0);
    }
  }
  return distribution.slice(9).reduce((total, value) => total + value, 0);
}

function summarize(predictions: PredictionRow[], meets: MeetPrediction[]) {
  const count = predictions.length;
  const accuracy = predictions.filter((row) => (row.probability >= 0.5 ? 1 : 0) === row.outcome).length / count;
  const brier = predictions.reduce((total, row) => total + (row.probability - row.outcome) ** 2, 0) / count;
  const logLoss = predictions.reduce((total, row) => {
    const probability = Math.min(1 - 1e-15, Math.max(1e-15, row.probability));
    return total - row.outcome * Math.log(probability) - (1 - row.outcome) * Math.log(1 - probability);
  }, 0) / count;
  const ece = Array.from({ length: 10 }, (_, bin) => {
    const rows = predictions.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === bin);
    if (!rows.length) return 0;
    const averageProbability = rows.reduce((total, row) => total + row.probability, 0) / rows.length;
    const averageOutcome = rows.reduce((total, row) => total + row.outcome, 0) / rows.length;
    return rows.length / count * Math.abs(averageProbability - averageOutcome);
  }).reduce((total, value) => total + value, 0);
  const baselineBrier = predictions.reduce((total, row) => total + (row.rollingOverall - row.outcome) ** 2, 0) / count;
  const baselineLog = predictions.reduce((total, row) => {
    const probability = Math.min(1 - 1e-15, Math.max(1e-15, row.rollingOverall));
    return total - row.outcome * Math.log(probability) - (1 - row.outcome) * Math.log(1 - probability);
  }, 0) / count;
  return {
    meets: meets.length,
    events: count,
    accuracy,
    brier,
    logLoss,
    ece,
    rollingOverallBrier: baselineBrier,
    rollingOverallLogLoss: baselineLog,
    alwaysWinAccuracy: predictions.reduce((total, row) => total + row.outcome, 0) / count,
    meetAccuracy: meets.filter((meet) => (meet.meetProbability >= 0.5) === (meet.actualWins >= 9)).length / meets.length,
    alwaysWinMeetAccuracy: meets.filter((meet) => meet.actualWins >= 9).length / meets.length,
    observedWins: meets.reduce((total, meet) => total + meet.actualWins, 0),
    expectedWins: meets.reduce((total, meet) => total + meet.expectedWins, 0),
    optimizedWins: meets.reduce((total, meet) => total + meet.optimizedWins, 0),
    objectiveDifference: meets.reduce((total, meet) => total + meet.optimizedWins - meet.expectedWins, 0),
  };
}

function evaluate(
  rawMatches: MatchRow[],
  rawRosters: RosterRow[],
  missingRows: CsvRow[],
  options: EvaluationOptions,
) {
  const matches = rawMatches.filter((row) => !(options.excludeEmerald && row.opponent === "Emerald"));
  const rosters = options.impute ? imputeRosters(rawRosters, missingRows) : rawRosters.map((row) => ({ ...row }));
  const rosterBySeasonPlayer = new Map(rosters.map((row) => [`${row.season}|${row.playerId}`, row]));
  const rosterBySeason = new Map<number, RosterRow[]>();
  for (const row of rosters) {
    const rows = rosterBySeason.get(row.season) ?? [];
    rows.push(row);
    rosterBySeason.set(row.season, rows);
  }

  const groups = groupMatches(matches).filter((rows) => !options.excludeRepeatedGroups || !hasRepeatedPlayer(rows));
  const playerState = new Map<string, PlayerState>();
  const positionState = new Map<string, PositionState>();
  const calibration = new Map<string, CalibrationSample[]>();
  const overallOutcomes: number[] = [];
  const positionOutcomes = new Map<EventCode, number[]>();
  const loadedSeasons = new Set<number>();
  const predictions: PredictionRow[] = [];
  const meetPredictions: MeetPrediction[] = [];
  let completeSeen = 0;

  const loadSeason = (season: number) => {
    if (loadedSeasons.has(season)) return;
    for (const roster of rosterBySeason.get(season) ?? []) {
      const floor = preseasonElo(roster.rank, roster.ladderSize);
      const current = playerState.get(roster.playerId);
      if (!current) playerState.set(roster.playerId, { elo: floor, lastFloorSeason: season });
      else if (current.lastFloorSeason < season) {
        current.elo = Math.max(current.elo, floor);
        current.lastFloorSeason = season;
      }
    }
    loadedSeasons.add(season);
  };

  const orderRows = (rows: MatchRow[]) => {
    if (options.eventOrder === "file") return [...rows];
    if (options.eventOrder === "lexicographic") return [...rows].sort((a, b) => a.position.localeCompare(b.position));
    const order = new Map(EVENT_ORDER.map((position, index) => [position, index]));
    return [...rows].sort((a, b) => (order.get(a.position) ?? Infinity) - (order.get(b.position) ?? Infinity));
  };

  const eventHasRoster = (row: MatchRow) => rosterBySeasonPlayer.has(`${row.season}|${row.player1}`)
    && (!row.player2 || rosterBySeasonPlayer.has(`${row.season}|${row.player2}`));

  const offsetFor = (opponent: string) => {
    const samples = calibration.get(opponent) ?? [];
    if (!samples.length) return 0;
    const actualWins = samples.reduce((total, sample) => total + sample.outcome, 0);
    return fitOpponentEloOffset(
      samples.map(({ homeElo, opponentElo }) => ({ homeElo, opponentElo })),
      smoothedHistoricalWins(actualWins, samples.length),
    );
  };

  const process = (rows: MatchRow[]) => {
    const skipWholeMeet = !options.impute
      && options.strictTrainingMissing === "skip-meet"
      && rows.some((row) => !eventHasRoster(row));
    if (skipWholeMeet) return;
    for (const row of orderRows(rows)) {
      if (!eventHasRoster(row)) continue;
      const first = playerState.get(row.player1);
      const second = row.player2 ? playerState.get(row.player2) : null;
      if (!first || (row.player2 && !second)) continue;
      const homeElo = first.elo + (second?.elo ?? 0);
      const positionKey = `${row.opponent}|${row.position}`;
      const position = positionState.get(positionKey);
      const priorOpponentElo = position?.elo ?? defaultPositionElo(row.position);
      const samples = calibration.get(row.opponent) ?? [];
      samples.push({ homeElo, opponentElo: priorOpponentElo, outcome: row.outcome });
      calibration.set(row.opponent, samples);
      const expected = eloWinProbability(homeElo, priorOpponentElo);
      const change = homePlayerEloChange(row.differential, row.outcome, expected);
      const playerChange = change / (second ? 2 : 1);
      first.elo += playerChange;
      if (second) second.elo += playerChange;
      const observation = homeElo - 8 * row.differential;
      const seasonWeight = row.season - 2022;
      const priorWeight = position?.totalWeight ?? 0;
      positionState.set(positionKey, {
        elo: priorWeight
          ? (priorOpponentElo * priorWeight + observation * seasonWeight) / (priorWeight + seasonWeight)
          : observation,
        totalWeight: priorWeight + seasonWeight,
      });
      overallOutcomes.push(row.outcome);
      const positionHistory = positionOutcomes.get(row.position) ?? [];
      positionHistory.push(row.outcome);
      positionOutcomes.set(row.position, positionHistory);
    }
  };

  for (const rows of groups) {
    const season = rows[0].season;
    loadSeason(season);
    const complete = isComplete(rows);
    const targetHasRoster = rows.every((row) => eventHasRoster(row));
    const eligible = complete
      && (options.impute || targetHasRoster);
    if (complete) completeSeen += 1;
    const heldOut = eligible && completeSeen > 1;
    if (heldOut) {
      const offset = offsetFor(rows[0].opponent);
      const probabilities: number[] = [];
      const meetRows: PredictionRow[] = [];
      for (const row of orderRows(rows)) {
        const first = playerState.get(row.player1);
        const second = row.player2 ? playerState.get(row.player2) : null;
        if (!first || (row.player2 && !second)) throw new Error(`Missing state for target ${row.date} ${row.position}.`);
        const homeElo = first.elo + (second?.elo ?? 0);
        const rawOpponent = positionState.get(`${row.opponent}|${row.position}`)?.elo ?? defaultPositionElo(row.position);
        const probability = eloWinProbability(homeElo, rawOpponent + offset);
        const rollingOverall = overallOutcomes.length
          ? overallOutcomes.reduce((total, value) => total + value, 0) / overallOutcomes.length
          : 0.5;
        const positionHistory = positionOutcomes.get(row.position) ?? [];
        const rollingPosition = positionHistory.length
          ? positionHistory.reduce((total, value) => total + value, 0) / positionHistory.length
          : rollingOverall;
        const prediction = {
          date: row.date,
          opponent: row.opponent,
          position: row.position,
          probability,
          outcome: row.outcome,
          rollingOverall,
          rollingPosition,
        };
        predictions.push(prediction);
        meetRows.push(prediction);
        probabilities.push(probability);
      }

      const targetRoster = rosterBySeason.get(season) ?? [];
      const players: PlayerRecord[] = targetRoster.map((roster) => ({
        id: roster.playerId,
        schoolId: "home",
        playerCode: roster.playerId,
        displayName: roster.name,
        gender: roster.gender,
        rank: roster.rank,
        initialElo: preseasonElo(roster.rank, roster.ladderSize),
        currentElo: playerState.get(roster.playerId)?.elo ?? preseasonElo(roster.rank, roster.ladderSize),
        firstSeason: season,
        lastSeason: season,
        active: true,
      }));
      const positionRatings: PositionRating[] = EVENT_ORDER.map((position) => ({
        position,
        currentElo: (positionState.get(`${rows[0].opponent}|${position}`)?.elo ?? defaultPositionElo(position)) + offset,
        totalWeight: positionState.get(`${rows[0].opponent}|${position}`)?.totalWeight ?? 0,
        matchesUsed: 0,
      }));
      const optimizedWins = options.runOptimizer
        ? optimizeLineup(players, positionRatings, makeSeasonFormat(season)).expectedWins
        : probabilities.reduce((total, probability) => total + probability, 0);
      meetPredictions.push({
        date: rows[0].date,
        opponent: rows[0].opponent,
        actualWins: meetRows.reduce((total, row) => total + row.outcome, 0),
        expectedWins: probabilities.reduce((total, probability) => total + probability, 0),
        optimizedWins,
        meetProbability: poissonBinomialMeetWin(probabilities),
      });
    }
    process(rows);
  }

  return { summary: summarize(predictions, meetPredictions), meets: meetPredictions };
}

const sourceRoot = path.resolve(process.env.RESEARCH_DATA_DIR ?? path.join(process.cwd(), "research-data"));
const inputPaths = {
  matches: path.join(sourceRoot, "historical_matches_analysis_ready.csv"),
  rosters: path.join(sourceRoot, "seasonal_rosters(1).csv"),
  missingRanks: path.join(sourceRoot, "missing_player_season_rankings.csv"),
};
for (const [label, filePath] of Object.entries(inputPaths)) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label} input: ${filePath}. Set RESEARCH_DATA_DIR to the authorized audit-data directory.`);
  }
}
const sha256 = (filePath: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const rawMatches = loadMatches(inputPaths.matches);
const rawRosters = loadRosters(inputPaths.rosters);
const missingRows = readCsv(inputPaths.missingRanks);

const variants: EvaluationOptions[] = [
  { impute: false, excludeEmerald: false, excludeRepeatedGroups: false, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
  { impute: true, excludeEmerald: false, excludeRepeatedGroups: false, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
  { impute: true, excludeEmerald: true, excludeRepeatedGroups: false, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
  { impute: false, excludeEmerald: false, excludeRepeatedGroups: true, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
  { impute: true, excludeEmerald: false, excludeRepeatedGroups: true, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
  { impute: true, excludeEmerald: true, excludeRepeatedGroups: true, runOptimizer: true, eventOrder: "event", strictTrainingMissing: "skip-event" },
];

const results = variants.map((options) => {
  const result = evaluate(rawMatches, rawRosters, missingRows, options);
  return { options, ...result };
});

const output = {
  modelVersion: "active-format-full-match-time-calibrated-once-v6",
  inputs: {
    matches: { file: path.basename(inputPaths.matches), sha256: sha256(inputPaths.matches), rows: rawMatches.length },
    rosters: { file: path.basename(inputPaths.rosters), sha256: sha256(inputPaths.rosters), rows: rawRosters.length },
    missingRanks: { file: path.basename(inputPaths.missingRanks), sha256: sha256(inputPaths.missingRanks), rows: missingRows.length },
  },
  variants: results,
};

if (process.env.VERIFY_AUDIT) {
  const expected = JSON.parse(fs.readFileSync(path.resolve(process.env.VERIFY_AUDIT), "utf8")) as {
    modelVersion: string;
    inputSha256: Record<string, string>;
    variants: Array<{ summary: ReturnType<typeof summarize> }>;
  };
  if (expected.modelVersion !== output.modelVersion) throw new Error("Frozen audit model version does not match.");
  for (const input of Object.values(output.inputs)) {
    if (expected.inputSha256[input.file] !== input.sha256) {
      throw new Error(`Input hash mismatch for ${input.file}.`);
    }
  }
  if (expected.variants.length !== output.variants.length) throw new Error("Frozen audit variant count does not match.");
  expected.variants.forEach((variant, index) => {
    if (JSON.stringify(variant.summary) !== JSON.stringify(output.variants[index].summary)) {
      throw new Error(`Frozen audit summary mismatch for variant ${index + 1}.`);
    }
  });
  console.error(`Verified ${output.variants.length} v6 evaluation variants against ${process.env.VERIFY_AUDIT}.`);
}

console.log(JSON.stringify(output, null, 2));
