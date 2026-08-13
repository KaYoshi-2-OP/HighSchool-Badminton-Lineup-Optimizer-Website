import {
  DEFAULT_EVENT_COUNTS,
  type EventCode,
  type PlayerRecord,
  type PositionRating,
  type SeasonFormat,
  defaultPositionElo,
  eloWinProbability,
  fitOpponentEloOffset,
  makeSeasonFormat,
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

function normalizeSingles(slots: PlayerRecord[], singlesCount: number) {
  const singles = slots.slice(0, singlesCount).sort((a, b) => a.rank - b.rank);
  return [...singles, ...slots.slice(singlesCount)];
}

function validSingles(slots: PlayerRecord[], singlesCount: number) {
  for (let index = 1; index < singlesCount; index += 1) {
    if (slots[index - 1].rank >= slots[index].rank) return false;
  }
  return true;
}

function assignments(
  state: State,
  ratings: Map<EventCode, number>,
  format: SeasonFormat,
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

  for (let index = 0; index < format.boysSingles; index += 1) {
    add(`BS${index + 1}` as EventCode, [state.boys[index]]);
  }
  for (let index = 0; index < format.girlsSingles; index += 1) {
    add(`GS${index + 1}` as EventCode, [state.girls[index]]);
  }
  for (let index = 0; index < format.boysDoubles; index += 1) {
    const start = format.boysSingles + index * 2;
    add(`BD${index + 1}` as EventCode, [state.boys[start], state.boys[start + 1]]);
  }
  for (let index = 0; index < format.girlsDoubles; index += 1) {
    const start = format.girlsSingles + index * 2;
    add(`GD${index + 1}` as EventCode, [state.girls[start], state.girls[start + 1]]);
  }
  const boysMixedStart = format.boysSingles + 2 * format.boysDoubles;
  const girlsMixedStart = format.girlsSingles + 2 * format.girlsDoubles;
  for (let index = 0; index < format.mixedDoubles; index += 1) {
    add(`XD${index + 1}` as EventCode, [state.boys[boysMixedStart + index], state.girls[girlsMixedStart + index]]);
  }
  const order = new Map(format.eventOrder.map((event, index) => [event, index]));
  return rows.sort((a, b) => (order.get(a.event) ?? Infinity) - (order.get(b.event) ?? Infinity));
}

function score(state: State, ratings: Map<EventCode, number>, format: SeasonFormat) {
  return assignments(state, ratings, format).reduce((sum, row) => sum + row.winProbability, 0);
}

function improve(initial: State, ratings: Map<EventCode, number>, format: SeasonFormat) {
  const state = { boys: [...initial.boys], girls: [...initial.girls] };
  let currentScore = score(state, ratings, format);

  for (let iteration = 0; iteration < 40; iteration += 1) {
    let bestScore = currentScore;
    let bestSwap: { gender: "boys" | "girls"; first: number; second: number } | null = null;
    for (const gender of ["boys", "girls"] as const) {
      const slots = state[gender];
      for (let first = 0; first < slots.length - 1; first += 1) {
        for (let second = first + 1; second < slots.length; second += 1) {
          [slots[first], slots[second]] = [slots[second], slots[first]];
          const singlesCount = gender === "boys" ? format.boysSingles : format.girlsSingles;
          const legal = validSingles(slots, singlesCount);
          const candidateScore = legal ? score(state, ratings, format) : -Infinity;
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
  format: SeasonFormat = makeSeasonFormat(2026, DEFAULT_EVENT_COUNTS),
): { lineup: OptimizedAssignment[]; expectedWins: number; rawExpectedWins: number; searches: number } {
  const active = allPlayers.filter((player) => player.active);
  const boys = active.filter((player) => player.gender === "Boys")
    .sort((a, b) => b.currentElo - a.currentElo).slice(0, format.requiredBoys);
  const girls = active.filter((player) => player.gender === "Girls")
    .sort((a, b) => b.currentElo - a.currentElo).slice(0, format.requiredGirls);
  if (boys.length < format.requiredBoys || girls.length < format.requiredGirls) {
    throw new Error(
      `This ${format.totalEvents}-event format requires at least ${format.requiredBoys} active boys and ${format.requiredGirls} active girls.`,
    );
  }

  const ratings = new Map(positionRatings.map((row) => [row.position, row.currentElo]));
  const random = seededRandom(
    [...boys, ...girls].reduce(
      (seed, player) => seed + Math.round(player.currentElo) * (player.rank + format.totalEvents),
      format.season,
    ),
  );
  const searches = Math.min(600, 120 + Math.max(0, format.totalEvents - 17) * 20);
  let best = improve({
    boys: normalizeSingles(boys, format.boysSingles),
    girls: normalizeSingles(girls, format.girlsSingles),
  }, ratings, format);

  for (let attempt = 1; attempt < searches; attempt += 1) {
    const candidate = improve({
      boys: normalizeSingles(shuffle(boys, random), format.boysSingles),
      girls: normalizeSingles(shuffle(girls, random), format.girlsSingles),
    }, ratings, format);
    if (candidate.score > best.score) best = candidate;
  }

  const rawLineup = assignments(best.state, ratings, format);
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
  const lineup = assignments(best.state, adjustedRatings, format);

  return {
    lineup,
    expectedWins: lineup.reduce((sum, row) => sum + row.winProbability, 0),
    rawExpectedWins: best.score,
    searches,
  };
}
