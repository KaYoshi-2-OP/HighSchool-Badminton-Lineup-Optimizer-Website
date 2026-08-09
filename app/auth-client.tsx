"use client";

import { FormEvent, useState } from "react";

type Mode = "login" | "register";

function AuthMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 4 6 6M8 2l5 6M12 2l3 5M4 8l6 4 6-5-4-5H8Z" />
      <path d="m10 12 7 8 3-3-4-10" />
    </svg>
  );
}

export default function AuthClient() {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const changeMode = (nextMode: Mode) => {
    setMode(nextMode);
    setPassword("");
    setConfirmation("");
    setError("");
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (mode === "register" && password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: mode, username, password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Authentication failed.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-intro">
        <div className="auth-brand"><span><AuthMark /></span><strong>Badminton Lineup Optimizer</strong></div>
        <p className="eyebrow">SEASON-AWARE TEAM ANALYTICS</p>
        <h1>Make every lineup decision with evidence.</h1>
        <p>Maintain one school’s roster, preserve player Elo across seasons, update opponent positional ratings, and search every legal lineup.</p>
        <div className="auth-benefits">
          <article><b>01</b><div><strong>Separate team workspace</strong><span>Each account has its own rosters, match history, and ratings.</span></div></article>
          <article><b>02</b><div><strong>Persistent rating history</strong><span>Returning players retain their earned Elo from prior seasons.</span></div></article>
          <article><b>03</b><div><strong>Private credentials</strong><span>Your password is transformed into a secure hash before storage.</span></div></article>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label="Account action">
            <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => changeMode("login")}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "active" : ""} onClick={() => changeMode("register")}>Create account</button>
          </div>
          <div className="auth-card-heading">
            <p className="eyebrow">{mode === "login" ? "WELCOME BACK" : "NEW TEAM WORKSPACE"}</p>
            <h2 id="auth-title">{mode === "login" ? "Sign in to your team" : "Create your account"}</h2>
            <p>{mode === "login" ? "Use the username and password you created." : "Choose credentials that are unique to you. No external identity is used."}</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>USERNAME</span>
              <input autoComplete="username" name="username" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={30} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,29}" required placeholder="team_username" />
              {mode === "register" && <small>3–30 letters, numbers, underscores, or hyphens</small>}
            </label>
            <label>
              <span>PASSWORD</span>
              <input autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} required placeholder="At least 8 characters" />
            </label>
            {mode === "register" && (
              <label>
                <span>CONFIRM PASSWORD</span>
                <input autoComplete="new-password" name="confirmation" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} maxLength={128} required placeholder="Enter the same password again" />
              </label>
            )}
            {error && <div className="auth-error" role="alert">{error}</div>}
            <button className="primary-button auth-submit" disabled={submitting} type="submit">
              {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
          <p className="auth-footnote">One account represents one home school. You can add multiple opponent schools after signing in.</p>
        </div>
      </section>
    </main>
  );
}
