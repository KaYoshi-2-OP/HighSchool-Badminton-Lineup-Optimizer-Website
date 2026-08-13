import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventOrder,
  fitOpponentEloOffset,
  homePlayerEloChange,
  makeSeasonFormat,
  smoothedHistoricalWins,
} from "../lib/domain.ts";
import { optimizeLineup } from "../lib/optimizer.ts";

test("home-player K=2 produces stable, signed updates", () => {
  assert.equal(homePlayerEloChange(20, 1, 0.5), 20);
  assert.equal(homePlayerEloChange(-20, 0, 0.5), -20);
});

test("historical target uses half-win smoothing at the extremes", () => {
  assert.equal(smoothedHistoricalWins(17, 17), 16.52777777777778);
  assert.equal(smoothedHistoricalWins(0, 17), 0.4722222222222222);
});

test("school calibration fits the requested expected-win total", () => {
  const samples = Array.from({ length: 17 }, () => ({ homeElo: 1800, opponentElo: 1800 }));
  const target = 11;
  const offset = fitOpponentEloOffset(samples, target);
  const projected = samples.reduce(
    (sum, sample) => sum + 1 / (1 + Math.pow(10, (sample.opponentElo + offset - sample.homeElo) / 400)),
    0,
  );
  assert.ok(Math.abs(projected - target) < 1e-8);
});

test("a custom 21-event format generates every requested position", () => {
  const format = makeSeasonFormat(2027, {
    boysSingles: 5,
    girlsSingles: 5,
    boysDoubles: 4,
    girlsDoubles: 4,
    mixedDoubles: 3,
  }, true);
  assert.equal(format.totalEvents, 21);
  assert.equal(format.winsNeeded, 11);
  assert.equal(format.requiredBoys, 16);
  assert.equal(format.requiredGirls, 16);
  assert.deepEqual(format.eventOrder, buildEventOrder(format));
  assert.equal(format.eventOrder.at(-1), "XD3");
});

test("the optimizer uses a custom format without changing Elo formulas", () => {
  const format = makeSeasonFormat(2027, {
    boysSingles: 5,
    girlsSingles: 5,
    boysDoubles: 4,
    girlsDoubles: 4,
    mixedDoubles: 3,
  }, true);
  const players = (["Boys", "Girls"] as const).flatMap((gender) =>
    Array.from({ length: 18 }, (_, index) => ({
      id: `${gender}-${index + 1}`,
      schoolId: "home",
      playerCode: `${gender === "Boys" ? "B" : "G"}${index + 1}`,
      displayName: `${gender} ${index + 1}`,
      gender,
      rank: index + 1,
      initialElo: 2200 - index * 50,
      currentElo: 2200 - index * 50,
      firstSeason: 2027,
      lastSeason: 2027,
      active: true,
    })),
  );
  const positions = format.eventOrder.map((position) => ({
    position,
    currentElo: position.startsWith("BS") || position.startsWith("GS") ? 1600 : 3200,
    totalWeight: 0,
    matchesUsed: 0,
  }));
  const result = optimizeLineup(players, positions, undefined, format);
  assert.equal(result.lineup.length, 21);
  assert.deepEqual(result.lineup.map((row) => row.event), format.eventOrder);
  assert.equal(result.searches, 200);
  const used = result.lineup.flatMap((row) => row.playerCodes);
  assert.equal(new Set(used).size, used.length);
  const boysSingles = result.lineup.filter((row) => row.event.startsWith("BS"));
  const girlsSingles = result.lineup.filter((row) => row.event.startsWith("GS"));
  for (const singles of [boysSingles, girlsSingles]) {
    const ranks = singles.map((row) => Number(row.playerCodes[0].slice(1)));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  }
});
