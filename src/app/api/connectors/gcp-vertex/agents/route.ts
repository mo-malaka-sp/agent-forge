import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest } from "next/server";

import { handleConnectorListRequest } from "@/lib/api/connector-route";
import { serializeGcpVertexAgentList } from "@/lib/providers/connector-serializers";

export const runtime = "nodejs";

async function GETUnscoped(request: NextRequest) {
  return handleConnectorListRequest(
    request,
    "gcp_vertex",
    serializeGcpVertexAgentList,
  );
}

export const GET = withFeatureTenant("govern", GETUnscoped);
