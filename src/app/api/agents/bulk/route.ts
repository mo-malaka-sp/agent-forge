import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { createAgentsBulk } from "@/lib/agents/repository";
import { serializeAgent } from "@/lib/agents/serializer";
import { jsonError, jsonValidationError } from "@/lib/api/response";
import { resolveBaseUrl } from "@/lib/url";
import { bulkCreateAgentsSchema } from "@/lib/validation/agent.schema";

export const runtime = "nodejs";

async function POSTUnscoped(request: NextRequest) {
  try {
    const body = await request.json();
    const payload = bulkCreateAgentsSchema.parse(body);
    const created = await createAgentsBulk(payload);
    const baseUrl = resolveBaseUrl(request.headers);

    return NextResponse.json(
      {
        created_count: created.length,
        agents: created.map((row) => serializeAgent(row, baseUrl)),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    console.error("POST /api/agents/bulk failed:", error);
    return jsonError("Failed to bulk create agents", 500);
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
