import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleAuthorizeRequest } from "@/lib/api/authorize-route";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function POSTUnscoped(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  return handleAuthorizeRequest(request, id);
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
