function message(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function GET(request: Request) {
  try {
    const { getDashboard } = await import("../../../lib/server-store");
    const url = new URL(request.url);
    const data = await getDashboard(url.searchParams.get("opponent") ?? undefined);
    return Response.json(data);
  } catch (error) {
    return Response.json({ error: message(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { confirmMeet, importMatches, importRosters, previewMeet } = await import("../../../lib/server-store");
    const payload = await request.json() as {
      action?: string;
      homeSchoolId?: string;
      opponentSchoolId?: string;
      rows?: Array<Record<string, string | number | null>>;
    };
    if (payload.action === "import_rosters") {
      return Response.json(await importRosters(payload.rows ?? []));
    }
    if (payload.action === "import_matches") {
      return Response.json(await importMatches(payload.rows ?? []));
    }
    if (payload.action === "preview_meet") {
      return Response.json(await previewMeet(payload.rows ?? []));
    }
    if (payload.action === "confirm_meet") {
      return Response.json(await confirmMeet(payload.rows ?? []));
    }
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return Response.json({ error: message(error) }, { status: 400 });
  }
}
