# High School Badminton Lineup Optimizer

A full-stack badminton analytics application that initializes player Elo ratings, learns opponent positional strength from historical match data, updates ratings after true match results, and searches for the legal 17-event lineup with the highest projected number of wins.

## Main features

- One permanently locked home school
- Separate boys' and girls' preseason Elo ladders
- Returning-player Elo continuity across seasons
- Ten-season rolling historical weighting
- Opponent ratings for BS1–BS4, GS1–GS4, BD1–BD3, GD1–GD3, and XD1–XD3
- Legal lineup generation with singles ladder-order rules
- Expected event wins and complete-meet win probability
- History-calibrated projections
- Direct entry of the true 17-event lineup and game scores
- Preview-before-save Elo changes
- Exact post-confirmation rating receipt
- CSV roster and historical-match imports
- Persistent Cloudflare D1 storage

## Technology

- TypeScript
- React 19
- Next.js-compatible Vinext runtime
- Vite
- Cloudflare Workers and D1
- Drizzle schema and migrations

## Rating formulas

### Preseason player rating

For ladder rank `r` in a ladder of size `N`:

```text
E(r) = 1000 + 1200 × ((N - r) / (N - 1))^1.8
```

### Returning players

```text
season_start_elo = max(previous_elo, new_rank_initialized_elo)
```

### Doubles rating

```text
pair_elo = player_1_elo + player_2_elo
```

### Event win probability

```text
P = 1 / (1 + 10^((opponent_elo - home_elo) / 400))
```

### Home-player update

```text
delta_elo = 2 × abs(point_differential) × (actual_result - expected_probability)
new_elo = old_elo + delta_elo
```

For doubles, each partner receives half of the event adjustment.

### Opponent positional observation

```text
opponent_observation = home_elo - 8 × point_differential
```

The observations are combined using season weights over the latest ten seasons.

### Lineup objective

```text
expected_wins = sum(event_win_probability for all 17 events)
```

The optimizer searches legal player assignments and returns the lineup with the greatest expected-win total found by the search.

## Requirements

- Node.js 22.13 or newer
- npm
- Git
- A Linux environment is recommended for the included bounded build scripts

GitHub Codespaces satisfies these requirements.

## Install and run

```bash
npm install
npm run dev
```

Open the address printed by the development server.

The application creates a local development D1 database automatically. If the database is empty, a fictional demonstration roster is inserted. Importing a real roster replaces the demonstration home school and locks the application to the imported school.

## Validate the project

```bash
npm run lint
npm test
```

`npm test` builds the application, validates the deployable Worker artifact, verifies the rendered HTML, and runs the rating-model tests.

## Input data

Ready-to-use examples are included in [`examples/data`](examples/data):

- `roster_example.csv`
- `match_results_example.csv`

The site can also generate downloadable CSV templates from the **Players** and **Data & Matches** sections.

### Roster columns

```text
school,season,player_id,name,gender,rank,ladder_size,active
```

Player IDs must stay stable across seasons. A returning player is recognized by this ID.

### Match-result columns

```text
date,home_school,opponent_school,position,home_player_1,home_player_2,g1_home,g1_opponent,g2_home,g2_opponent,g3_home,g3_opponent
```

Use one row for every event. Leave `home_player_2` blank for singles and leave Game 3 blank for a two-game event.

## True match workflow

1. Open **Enter Results**.
2. Select the date and opponent.
3. Enter the players who actually competed in all 17 events.
4. Enter the completed game scores.
5. Select **Preview Elo Changes**.
6. Review the projected player and opponent-position changes.
7. Select **Confirm and Save Meet**.
8. Review the exact post-replay rating receipt.

Nothing is saved during the preview step.

## Project structure

```text
app/                  User interface and API route
db/                   Drizzle database schema
drizzle/              D1 migration files
lib/domain.ts         Elo formulas and shared rating rules
lib/optimizer.ts      Legal lineup search and scoring
lib/server-store.ts   Imports, persistence, replay, calibration, and receipts
tests/                Build and rating-model tests
examples/data/        Example CSV inputs
worker/               Cloudflare Worker entry point
```

## Uploading to GitHub

See [`GITHUB_UPLOAD.md`](GITHUB_UPLOAD.md) for browser-upload, Codespaces, and command-line instructions.

## Deployment note

This application requires a Cloudflare D1 binding named `DB`. The included `.openai/hosting.json` configures that logical binding for ChatGPT Sites. If deploying elsewhere, configure an equivalent D1 database and bind it as `DB`.

## Research status

The application is a decision-support and research system. Historical calibration demonstrates that the model can reproduce the supplied historical results, but this is not the same as testing on unseen future matches. Predictive claims should be based on later out-of-sample evaluation.
