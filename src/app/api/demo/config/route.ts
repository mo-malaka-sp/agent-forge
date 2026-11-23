import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";
import { getIscPublicStatus } from "@/lib/isc/config";
import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";

export const runtime = "nodejs";

async function GETUnscoped(request: Request) {
  return withRequestIscRuntime(request, undefined, async () =>
    NextResponse.json(getIscPublicStatus()),
  );
}

export const GET = withFeatureTenant("govern", GETUnscoped);
