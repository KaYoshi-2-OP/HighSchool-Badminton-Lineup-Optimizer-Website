function message(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function GET(request: Request) {
  try {
    const { getAccountFromCookieHeader } = await import("../../../lib/auth");
    const { getDashboard } = await import("../../../lib/server-store");
    const account = await getAccountFromCookieHeader(request.headers.get("cookie"));
    if (!account) return Response.json({ error: "Sign in to continue." }, { status: 401 });
    const url = new URL(request.url);
    const data = await getDashboard(account, url.searchParams.get("opponent") ?? undefined);
    return Response.json(data);
  } catch (error) {
    return Response.json({ error: message(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { assertSameOrigin, getAccountFromCookieHeader } = await import("../../../lib/auth");
    const { confirmMeet, importMatches, importRosters, previewMeet, saveSeasonFormat } = await import("../../../lib/server-store");
    assertSameOrigin(request);
    const account = await getAccountFromCookieHeader(request.headers.get("cookie"));
    if (!account) return Response.json({ error: "Sign in to continue." }, { status: 401 });
    const payload = await request.json() as {
      action?: string;
      homeSchoolId?: string;
      opponentSchoolId?: string;
      rows?: Array<Record<string, string | number | null>>;
      season?: number;
      boysSingles?: number;
      girlsSingles?: number;
      boysDoubles?: number;
      girlsDoubles?: number;
      mixedDoubles?: number;
    };
    if (payload.action === "import_rosters") {
      return Response.json(await importRosters(account, payload.rows ?? []));
    }
    if (payload.action === "import_matches") {
      return Response.json(await importMatches(account, payload.rows ?? []));
    }
    if (payload.action === "preview_meet") {
      return Response.json(await previewMeet(account, payload.rows ?? []));
    }
    if (payload.action === "confirm_meet") {
      return Response.json(await confirmMeet(account, payload.rows ?? []));
    }
    if (payload.action === "save_season_format") {
      return Response.json(await saveSeasonFormat(account, {
        season: Number(payload.season),
        boysSingles: Number(payload.boysSingles),
        girlsSingles: Number(payload.girlsSingles),
        boysDoubles: Number(payload.boysDoubles),
        girlsDoubles: Number(payload.girlsDoubles),
        mixedDoubles: Number(payload.mixedDoubles),
      }));
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: message(error) }, { status: 400 });
  }
}
