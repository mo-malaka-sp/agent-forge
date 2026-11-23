import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest, NextResponse } from "next/server";

import { getAgentById } from "@/lib/agents/repository";
import { serializeAgent } from "@/lib/agents/serializer";
import { jsonError } from "@/lib/api/response";
import { PLATFORM_ID, SCHEMA_VERSION } from "@/lib/constants";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function GETUnscoped(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const agent = await getAgentById(id);

    if (!agent) {
      return jsonError("Agent not found", 404);
    }

    const serialized = serializeAgent(agent, resolveBaseUrl(request.headers));

    return NextResponse.json({
      schema_version: SCHEMA_VERSION,
      platform: PLATFORM_ID,
      generated_at: new Date().toISOString(),
      agent_id: serialized.id,
      entitlements: serialized.iam.entitlements,
    });
  } catch (error) {
    console.error("GET /api/agents/[id]/entitlements failed:", error);
    return jsonError("Failed to fetch entitlements", 500);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
