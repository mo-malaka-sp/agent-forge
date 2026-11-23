import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleWebServicesEntitlementListRequest } from "@/lib/api/web-services-entitlements-route";

export const runtime = "nodejs";

async function GETUnscoped(request: NextRequest) {
  return handleWebServicesEntitlementListRequest(request, "gcp_vertex");
}

export const GET = withFeatureTenant("govern", GETUnscoped);
