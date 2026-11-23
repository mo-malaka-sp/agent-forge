import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleWebServicesAccountListRequest } from "@/lib/api/web-services-route";

export const runtime = "nodejs";

async function GETUnscoped(request: NextRequest) {
  return handleWebServicesAccountListRequest(request, "azure_ai_foundry");
}

export const GET = withFeatureTenant("govern", GETUnscoped);
