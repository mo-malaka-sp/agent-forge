import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleRemoveEntitlementRequest } from "@/lib/api/web-services-provision-route";

export const runtime = "nodejs";

async function POSTUnscoped(request: NextRequest) {
  return handleRemoveEntitlementRequest(request, "gcp_vertex");
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
