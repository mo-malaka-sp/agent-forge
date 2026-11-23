import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleConnectorListRequest } from "@/lib/api/connector-route";
import { serializeAzureAiFoundryAgentList } from "@/lib/providers/connector-serializers";

export const runtime = "nodejs";

async function GETUnscoped(request: NextRequest) {
  return handleConnectorListRequest(
    request,
    "azure_ai_foundry",
    serializeAzureAiFoundryAgentList,
  );
}

export const GET = withFeatureTenant("govern", GETUnscoped);
