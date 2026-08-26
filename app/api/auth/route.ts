function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function GET(request: Request) {
  try {
    const { getAccountFromCookieHeader } = await import("../../../lib/auth");
    const account = await getAccountFromCookieHeader(request.headers.get("cookie"));
    return Response.json(
      { account: account ? { username: account.username } : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "The account service is temporarily unavailable." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { assertSameOrigin, loginAccount, registerAccount, sessionCookie } = await import("../../../lib/auth");
    assertSameOrigin(request);
    const payload = await request.json() as {
      action?: "login" | "register";
      username?: string;
      password?: string;
    };

    const result = payload.action === "register"
      ? await registerAccount(payload.username ?? "", payload.password ?? "")
      : payload.action === "login"
        ? await loginAccount(payload.username ?? "", payload.password ?? "")
        : null;

    if (!result) return Response.json({ error: "Unknown authentication action." }, { status: 400 });

    return Response.json(
      { account: { username: result.account.username } },
      { headers: { "Set-Cookie": sessionCookie(result.token, request.url) } },
    );
  } catch (error) {
  console.error("Authentication request failed:", error);
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    return Response.json(
      { error: status === 500 ? "The account service is temporarily unavailable." : errorMessage(error) },
      { status },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { assertSameOrigin, clearSessionCookies, deleteSession } = await import("../../../lib/auth");
    assertSameOrigin(request);
    await deleteSession(request.headers.get("cookie"));
    const headers = new Headers();
    for (const cookie of clearSessionCookies()) headers.append("Set-Cookie", cookie);
    return Response.json({ success: true }, { headers });
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    return Response.json({ error: errorMessage(error) }, { status });
  }
}
