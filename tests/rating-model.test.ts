import assert from "node:assert/strict";
import test from "node:test";
import {
  fitOpponentEloOffset,
  homePlayerEloChange,
  smoothedHistoricalWins,
} from "../lib/domain.ts";

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
