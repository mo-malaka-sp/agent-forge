import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Amplify injects AWS_COMMIT_ID at build time. */
const COMMIT =
  process.env.AWS_COMMIT_ID?.trim() ||
  process.env.NEXT_PUBLIC_COMMIT_SHA?.trim() ||
  null;

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "agent-forge",
    timestamp: new Date().toISOString(),
    commit: COMMIT,
    /** Which ISC dataset API family this build calls — confirms a deploy landed. */
    datasetApi: "/sources/v1/{sourceId}/datasets/{datasetId}/aggregate",
  });
}
