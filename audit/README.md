# Frozen v6 research audit

This directory contains aggregate, non-identifying outputs for the frozen model
`active-format-full-match-time-calibrated-once-v6`. Raw student records are not
committed.

To regenerate the audit with authorized files:

```bash
RESEARCH_DATA_DIR=/absolute/path/to/audit-data npm run evaluate > evaluation.json
```

The directory must contain:

| File | SHA-256 | Data rows |
| --- | --- | ---: |
| `historical_matches_analysis_ready.csv` | `7e82ccb6e54c0ae17246ccbc7096a8181a307eeb59a3c896a2234b3a7de2c10d` | 507 |
| `seasonal_rosters(1).csv` | `cc595a39fd68ccc9d7adca0b212739302391245f0948502d3eff631fb5c3cc0d` | 196 |
| `missing_player_season_rankings.csv` | `c4cc1c2372c898e470ab7aa220d2c576b67ac9cb6082a53b6e18c244b07d0558` | 8 |

The evaluator groups rows by date and opponent, predicts each eligible target
meet before processing any of its outcomes, and then advances chronologically.
The first complete meet is a warm-up. The no-imputation analysis skips training
events without a player-season roster record and scores only complete targets
with full roster coverage. The imputation sensitivity adds each missing
player-season record at the bottom of the inferred gender ladder and recalculates
the affected preseason ratings.

Two complete source groups record repeated home players. The main event-prediction
analyses retain those source rows. Separate variants remove the entire affected
meet groups from both training and testing. Emerald exclusions are likewise
applied to both training and testing.

`verified-results-v6.json` stores the exact aggregate results used by the paper.
The optimized expected-win totals are counterfactual outputs of the same model
that chose the lineups; they are not observed wins or causal treatment effects.

