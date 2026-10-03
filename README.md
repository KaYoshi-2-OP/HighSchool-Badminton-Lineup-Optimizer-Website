# High School Badminton Lineup Optimizer

A full-stack website for high school badminton programs. It maintains a continuous Elo history for the home roster, estimates each opponent school’s positional strength from weighted historical results, and searches lineups satisfying its implemented constraints for the highest expected number of event wins.

## Main features

- Custom username-and-password accounts with separate data for every user
- One fixed home school per account
- Rank-based preseason player Elo initialization
- Returning-player Elo continuity across seasons
- Ten-season rolling weights for opponent positional ratings
- Actual lineup and score entry with previewed rating changes
- Per-season league formats with separate BS, GS, BD, GD, and XD counts
- Format-aware lineup search with additional search starts for larger meets
- CSV roster and historical-match imports

## Account security

Passwords are stored as PBKDF2-HMAC-SHA256 hashes with independent random salts and 600,000 iterations. Authentication uses random server-side sessions in `HttpOnly`, `Secure`, `SameSite=Strict` cookies. Repeated failed logins are rate-limited. The API derives the account from the protected session and scopes every database operation to that account; it never trusts an account identifier sent by the browser.

The current version does not provide password recovery. A production administrator should add a verified recovery process before serving a large public user base.

## Run in Codespaces

```bash
npm install
npm test
npm run dev
```

Open the forwarded port shown by Codespaces. Create a local account, import a roster, save the season's league format, and then import or enter match data.

## Publish from GitHub

The source lives in GitHub, while Cloudflare Workers and D1 provide the server and database that GitHub Pages does not support. Follow [GITHUB_DEPLOYMENT.md](GITHUB_DEPLOYMENT.md). Once configured, every push to `main` is tested and deployed by the included GitHub Actions workflow.

## CSV formats

Roster columns:

```text
school,season,player_id,name,gender,rank,ladder_size,active
```

Historical match columns:

```text
date,home_school,opponent_school,position,home_player_1,home_player_2,g1_home,g1_opponent,g2_home,g2_opponent,g3_home,g3_opponent
```

The website provides downloadable templates for both formats. Every match position is checked against the format saved for the year in the `date` column. Seasons without an explicit setting retain the original 4 BS, 4 GS, 3 BD, 3 GD, and 3 XD format (17 total events).

## League formats

Before entering a season's results, users choose the number of boys singles, girls singles, boys doubles, girls doubles, and mixed doubles events. The website then generates the numbered positions, calculates the required roster size, and uses a strict majority as the outright-win threshold. Even-sized formats are supported, although they can produce tied meets. A format cannot be changed after results for that season have been saved.

## Rating rules

- Preseason Elo: `1000 + 1200 × ((N − r) / (N − 1))^1.8`
- Event win probability: `1 / (1 + 10^((opponent Elo − home Elo) / 400))`
- Home-player update: a deliberately small `K = 2`, adjusted by margin, multiplied by `actual − expected`
- Positional observation: `home participant Elo − 8 × point differential`
- Opponent positional Elo: weighted mean of positional observations within the active ten-season window
- Doubles team Elo: sum of both players’ Elo ratings
- School-level historical calibration: one opponent-wide Elo offset fitted from prior events only
- Optimizer projection: calculated directly from the calibrated positional Elo values; no second lineup-level historical anchor
- Standard 17-event optimizer search: 120 deterministic starts, up to 40 improving swap rounds per start

Changing the league format does not change any Elo or probability formula. It only changes the event set and the lineup assignments evaluated by the optimizer.

## Rules boundary

The optimizer enforces filled slots, unique athletes, gender-category assignments, distinct partners, and ascending supplied ranks in singles. It does **not** quantify or enforce order-of-skill for doubles or mixed doubles. Those pair-order decisions are difficult to infer when skill differences are small and must be reviewed by a coach against the applicable league rules. The website is therefore not a lineup-eligibility or rules-certification system.

## Research evaluation

The aggregate v6 audit is recorded in [`audit/verified-results-v6.json`](audit/verified-results-v6.json). Authorized users can regenerate it with private input files by setting `RESEARCH_DATA_DIR` and running `npm run evaluate`. The raw student records are intentionally not committed. See [`audit/README.md`](audit/README.md) for file names, hashes, and interpretation limits.

The frozen research model is `active-format-full-match-time-calibrated-once-v6`.

See the research paper, audit notes, and source comments for the assumptions, limitations, and validation plan.
