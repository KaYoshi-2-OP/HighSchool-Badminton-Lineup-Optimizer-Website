"use client";

import { useState } from "react";

const CLAUDE_CONVERSION_PROMPT = `You are a data-formatting assistant for a high school badminton lineup optimizer.

I will attach one or more files containing:
1. Seasonal home-school rosters
2. Historical badminton match results

Convert the information into exactly two CSV files. Do not calculate Elo ratings. Do not predict results. Do not invent missing data.

FILE 1: roster.csv

Use exactly these columns:

school,season,player_id,name,gender,rank,ladder_size,active

Rules:
- Include only one home school.
- Use one row per player per season.
- gender must be Boys or Girls.
- rank must be the player's numerical ladder rank for that season.
- ladder_size must equal the number of ranked players of that gender in that season.
- If the same person appears in multiple seasons, give them the same stable player_id in every season.
- Different people must never share a player_id.
- Use active=1 only for players on the newest provided roster.
- Use active=0 for players appearing only on older rosters.
- Preserve the player's actual name unless the input uses anonymous identifiers.
- Sort by season, gender, and rank.

FILE 2: match_history.csv

Use exactly these columns:

date,home_school,opponent_school,position,home_player_1,home_player_2,g1_home,g1_opponent,g2_home,g2_opponent,g3_home,g3_opponent

Rules:
- Use one row per event.
- date must use YYYY-MM-DD.
- The valid positions are:
  BS1, BS2, BS3, BS4,
  GS1, GS2, GS3, GS4,
  BD1, BD2, BD3,
  GD1, GD2, GD3,
  XD1, XD2, XD3.
- home_school must match the school in roster.csv.
- home_player_1 and home_player_2 must use player_id values from roster.csv.
- For singles, leave home_player_2 blank.
- For doubles and mixed doubles, both player fields are required.
- Enter scores from the home school's perspective.
- A two-game match must leave both G3 fields blank.
- Include scrimmages if they appear in the source data.
- Do not include incomplete or cancelled matches.
- Do not calculate point differential.
- Sort matches chronologically and then by event position.

VALIDATION:
- Verify every match player exists in roster.csv.
- Verify every match is a completed best-of-three result.
- Verify no game score is tied.
- Verify dates, schools, player IDs, and positions are consistent.
- Verify returning players retain the same player_id across seasons.
- Do not guess unclear names, dates, ranks, positions, or scores.

If information is unclear:
- Do not invent a value.
- Create needs_review.csv.
- Include the source location, unclear value, and an explanation.

After processing:
1. Display a validation summary.
2. Report the number of roster and match rows.
3. List every assumption made.
4. Provide roster.csv and match_history.csv as downloadable files.
5. Provide needs_review.csv if anything requires manual review.`;

export default function ClaudeImportAssistant() {
  const [message, setMessage] = useState("");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(CLAUDE_CONVERSION_PROMPT);
      setMessage("The conversion prompt has been copied.");
    } catch {
      window.prompt(
        "Copy the following prompt, then paste it into Claude:",
        CLAUDE_CONVERSION_PROMPT,
      );
      setMessage("Copy the prompt shown in the dialog.");
    }
  }

  async function openClaude() {
    // Open Claude immediately so the browser does not block the new tab.
    window.open(
      "https://claude.ai/new",
      "_blank",
      "noopener,noreferrer",
    );

    await copyPrompt();
    setMessage(
      "Claude has been opened. Paste the copied prompt and attach your spreadsheet.",
    );
  }

  return (
    <section className="panel import-panel">
      <div className="upload-mark" aria-hidden="true">
        AI
      </div>

      <p className="eyebrow">OPTIONAL · NO API KEY REQUIRED</p>
      <h2>Format raw files with Claude</h2>

      <p>
        Claude can reorganize seasonal rosters and historical results into the
        two CSV formats accepted by this optimizer. Your Elo calculations and
        lineup optimization remain inside this website.
      </p>

      <ol
        style={{
          margin: "20px 0",
          paddingLeft: "22px",
          lineHeight: 1.8,
        }}
      >
        <li>Click the button below.</li>
        <li>Sign in to Claude using your own account.</li>
        <li>Paste the prompt that was copied automatically.</li>
        <li>Attach your roster and match-result spreadsheets.</li>
        <li>Download the CSV files Claude creates.</li>
        <li>Return here and import those CSV files.</li>
      </ol>

      <button
        className="primary-button"
        type="button"
        onClick={() => void openClaude()}
      >
        Copy Prompt and Open Claude
      </button>

      <button
        className="text-button"
        type="button"
        onClick={() => void copyPrompt()}
      >
        Copy Prompt Only
      </button>

      {message && (
        <p
          role="status"
          style={{
            marginTop: "18px",
            color: "#087f82",
            fontWeight: 700,
          }}
        >
          {message}
        </p>
      )}
    </section>
  );
}