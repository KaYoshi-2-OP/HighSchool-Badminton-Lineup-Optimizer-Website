import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const audit = JSON.parse(fs.readFileSync(new URL("../audit/verified-results-v6.json", import.meta.url), "utf8"));

test("frozen v6 audit has all six declared variants and verified input hashes", () => {
  assert.equal(audit.modelVersion, "active-format-full-match-time-calibrated-once-v6");
  assert.equal(audit.variants.length, 6);
  assert.equal(audit.inputSha256["historical_matches_analysis_ready.csv"].length, 64);
  assert.equal(audit.inputSha256["seasonal_rosters(1).csv"].length, 64);
  assert.equal(audit.inputSha256["missing_player_season_rankings.csv"].length, 64);
});

test("reported objective differences equal optimized minus historical expected wins", () => {
  for (const variant of audit.variants) {
    const summary = variant.summary;
    assert.ok(Math.abs(summary.optimizedWins - summary.expectedWins - summary.objectiveDifference) < 1e-10);
    assert.equal(summary.events, summary.meets * 17);
    assert.ok(summary.accuracy >= 0 && summary.accuracy <= 1);
    assert.ok(summary.brier >= 0 && summary.brier <= 1);
    assert.ok(summary.ece >= 0 && summary.ece <= 1);
  }
});

test("paper table values round from the frozen audit without manual alteration", () => {
  const primary = audit.variants.find((variant) => variant.id === "no-imputation").summary;
  const imputed = audit.variants.find((variant) => variant.id === "bottom-rank-imputation").summary;
  assert.equal((100 * primary.accuracy).toFixed(1), "58.2");
  assert.equal(primary.brier.toFixed(3), "0.344");
  assert.equal(primary.logLoss.toFixed(3), "1.331");
  assert.equal(primary.expectedWins.toFixed(2), "76.38");
  assert.equal(primary.optimizedWins.toFixed(2), "125.09");
  assert.equal((100 * imputed.accuracy).toFixed(1), "67.8");
  assert.equal(imputed.brier.toFixed(3), "0.265");
  assert.equal(imputed.logLoss.toFixed(3), "1.052");
  assert.equal(imputed.expectedWins.toFixed(2), "275.03");
  assert.equal(imputed.optimizedWins.toFixed(2), "365.80");
  assert.equal(audit.coldStartCheck.historicalLineupExpectedWins.toFixed(2), "2.46");
  assert.equal(audit.coldStartCheck.optimizedLineupExpectedWins.toFixed(2), "14.10");
});

