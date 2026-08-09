"use client";

import { useEffect, useState } from "react";
import AuthClient from "./auth-client";
import DashboardClient from "./dashboard-client";

type SessionAccount = { username: string };

export default function SessionGate() {
  const [account, setAccount] = useState<SessionAccount | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetch("/api/auth", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("The account service could not be reached.");
        return response.json() as Promise<{ account: SessionAccount | null }>;
      })
      .then((payload) => { if (active) setAccount(payload.account); })
      .catch(() => { if (active) setAccount(null); });
    return () => { active = false; };
  }, []);

  if (account === undefined) {
    return (
      <main className="session-loading" aria-live="polite">
        <span />
        <strong>Badminton Lineup Optimizer</strong>
        <p>Opening your team workspace…</p>
      </main>
    );
  }

  return account ? <DashboardClient currentUser={account} /> : <AuthClient />;
}
