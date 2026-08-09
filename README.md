# High School Badminton Lineup Optimizer

A full-stack website for high school badminton programs. It maintains a continuous Elo history for the home roster, estimates each opponent school’s positional strength from weighted historical results, and searches legal lineups for the highest expected number of event wins.

## Main features

- Custom username-and-password accounts with separate data for every user
- One fixed home school per account
- Rank-based preseason player Elo initialization
- Returning-player Elo continuity across seasons
- Ten-season rolling weights for opponent positional ratings
- Actual lineup and score entry with previewed rating changes
- Exhaustive legal-lineup search across all 17 dual-meet events
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

Open the forwarded port shown by Codespaces. Create a local account, then import roster and match data through the website.

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

The website provides downloadable templates for both formats.

## Rating rules

- Preseason Elo: `1000 + 1200 × ((N − r) / (N − 1))^1.8`
- Event win probability: `1 / (1 + 10^((opponent Elo − home Elo) / 400))`
- Home-player update: a deliberately small `K = 2`, adjusted by margin, multiplied by `actual − expected`
- Positional observation: `home participant Elo − 8 × point differential`
- Opponent positional Elo: weighted mean of positional observations within the active ten-season window
- Doubles team Elo: sum of both players’ Elo ratings

See the research paper and source comments for the assumptions, limitations, and validation plan.
