import {
  EVENT_ORDER,
  type EventCode,
  type PlayerRecord,
  type PositionRating,
  defaultPositionElo,
  eloWinProbability,
  fitOpponentEloOffset,
} from "./domain";

export type OptimizedAssignment = {
  event: EventCode;
  playerCodes: string[];
  playerNames: string[];
  playerElo: number;
  opponentElo: number;
  winProbability: number;
};

type State = {
  boys: PlayerRecord[];
  girls: PlayerRecord[];
};

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function normalizeSingles(slots: PlayerRecord[]) {
  const singles = slots.slice(0, 4).sort((a, b) => a.rank - b.rank);
  return [...singles, ...slots.slice(4)];
}

function validSingles(slots: PlayerRecord[]) {
  return slots[0].rank < slots[1].rank
    && slots[1].rank < slots[2].rank
    && slots[2].rank < slots[3].rank;
}

function assignments(
  state: State,
  ratings: Map<EventCode, number>,
): OptimizedAssignment[] {
  const rows: OptimizedAssignment[] = [];
  const add = (event: EventCode, players: PlayerRecord[]) => {
    const playerElo = players.reduce((sum, player) => sum + player.currentElo, 0);
    const opponentElo = ratings.get(event) ?? defaultPositionElo(event);
    rows.push({
      event,
      playerCodes: players.map((player) => player.playerCode),
      playerNames: players.map((player) => player.displayName),
      playerElo,
      opponentElo,
      winProbability: eloWinProbability(playerElo, opponentElo),
    });
  };

  for (let index = 0; index < 4; index += 1) {
    add(`BS${index + 1}` as EventCode, [state.boys[index]]);
    add(`GS${index + 1}` as EventCode, [state.girls[index]]);
  }
  for (let index = 0; index < 3; index += 1) {
    add(`BD${index + 1}` as EventCode, [state.boys[4 + index * 2], state.boys[5 + index * 2]]);
    add(`GD${index + 1}` as EventCode, [state.girls[4 + index * 2], state.girls[5 + index * 2]]);
    add(`XD${index + 1}` as EventCode, [state.boys[10 + index], state.girls[10 + index]]);
  }
  return rows.sort((a, b) => EVENT_ORDER.indexOf(a.event) - EVENT_ORDER.indexOf(b.event));
}

function score(state: State, ratings: Map<EventCode, number>) {
  return assignments(state, ratings).reduce((sum, row) => sum + row.winProbability, 0);
}

function improve(initial: State, ratings: Map<EventCode, number>) {
  const state = { boys: [...initial.boys], girls: [...initial.girls] };
  let currentScore = score(state, ratings);

  for (let iteration = 0; iteration < 40; iteration += 1) {
    let bestScore = currentScore;
    let bestSwap: { gender: "boys" | "girls"; first: number; second: number } | null = null;
    for (const gender of ["boys", "girls"] as const) {
      const slots = state[gender];
      for (let first = 0; first < slots.length - 1; first += 1) {
        for (let second = first + 1; second < slots.length; second += 1) {
          [slots[first], slots[second]] = [slots[second], slots[first]];
          const legal = validSingles(slots);
          const candidateScore = legal ? score(state, ratings) : -Infinity;
          [slots[first], slots[second]] = [slots[second], slots[first]];
          if (candidateScore > bestScore + 1e-10) {
            bestScore = candidateScore;
            bestSwap = { gender, first, second };
          }
        }
      }
    }
    if (!bestSwap) break;
    const slots = state[bestSwap.gender];
    [slots[bestSwap.first], slots[bestSwap.second]] = [slots[bestSwap.second], slots[bestSwap.first]];
    currentScore = bestScore;
  }
  return { state, score: currentScore };
}

export function optimizeLineup(
  allPlayers: PlayerRecord[],
  positionRatings: PositionRating[],
  historicalWinsPerMeet?: number,
): { lineup: OptimizedAssignment[]; expectedWins: number; rawExpectedWins: number; searches: number } {
  const active = allPlayers.filter((player) => player.active);
  const boys = active.filter((player) => player.gender === "Boys")
    .sort((a, b) => b.currentElo - a.currentElo).slice(0, 13);
  const girls = active.filter((player) => player.gender === "Girls")
    .sort((a, b) => b.currentElo - a.currentElo).slice(0, 13);
  if (boys.length < 13 || girls.length < 13) {
    throw new Error("A complete lineup requires at least 13 active boys and 13 active girls.");
  }

  const ratings = new Map(positionRatings.map((row) => [row.position, row.currentElo]));
  const random = seededRandom(
    [...boys, ...girls].reduce((seed, player) => seed + Math.round(player.currentElo) * (player.rank + 17), 2026),
  );
  const searches = 120;
  let best = improve({ boys: normalizeSingles(boys), girls: normalizeSingles(girls) }, ratings);

  for (let attempt = 1; attempt < searches; attempt += 1) {
    const candidate = improve({
      boys: normalizeSingles(shuffle(boys, random)),
      girls: normalizeSingles(shuffle(girls, random)),
    }, ratings);
    if (candidate.score > best.score) best = candidate;
  }

  const rawLineup = assignments(best.state, ratings);
  const hasHistoricalAnchor = Number.isFinite(historicalWinsPerMeet);
  const targetWins = hasHistoricalAnchor
    ? Number(historicalWinsPerMeet) + 0.5 * (best.score - Number(historicalWinsPerMeet))
    : best.score;
  const lineupOffset = hasHistoricalAnchor
    ? fitOpponentEloOffset(
        rawLineup.map((row) => ({ homeElo: row.playerElo, opponentElo: row.opponentElo })),
        targetWins,
      )
    : 0;
  const adjustedRatings = new Map(
    [...ratings].map(([event, rating]) => [event, rating + lineupOffset]),
  );
  const lineup = assignments(best.state, adjustedRatings);

  return {
    lineup,
    expectedWins: lineup.reduce((sum, row) => sum + row.winProbability, 0),
    rawExpectedWins: best.score,
    searches,
  };
}
