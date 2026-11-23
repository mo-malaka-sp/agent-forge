import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleGetProvisionAccountRequest } from "@/lib/api/web-services-provision-route";

export const runtime = "nodejs";

async function GETUnscoped(request: NextRequest) {
  return handleGetProvisionAccountRequest(request, "azure_ai_foundry");
}

export const GET = withFeatureTenant("govern", GETUnscoped);
