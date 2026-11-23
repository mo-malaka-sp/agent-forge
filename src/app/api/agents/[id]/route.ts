import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import {
  deleteAgent,
  getAgentById,
} from "@/lib/agents/repository";
import { serializeAgentDetail } from "@/lib/agents/serializer";
import { updateAgent as updateAgentRow } from "@/lib/db/store";
import { jsonError, jsonValidationError } from "@/lib/api/response";
import { resolveBaseUrl } from "@/lib/url";
import { updateAgentSchema } from "@/lib/validation/agent.schema";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function nowIso(): string {
  return new Date().toISOString();
}

async function GETUnscoped(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const agent = await getAgentById(id);

    if (!agent) {
      return jsonError("Agent not found", 404);
    }

    return NextResponse.json(
      serializeAgentDetail(agent, resolveBaseUrl(request.headers)),
    );
  } catch (error) {
    console.error("GET /api/agents/[id] failed:", error);
    return jsonError("Failed to fetch agent", 500);
  }
}

async function PATCHUnscoped(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = updateAgentSchema.parse(await request.json());
    const existing = await getAgentById(id);

    if (!existing) {
      return jsonError("Agent not found", 404);
    }

    const timestamp = nowIso();
    const updated = updateAgentRow(id, {
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.entitlements !== undefined
        ? { entitlements: JSON.stringify(body.entitlements) }
        : {}),
      ...(body.inbound_access !== undefined
        ? { inboundAccess: JSON.stringify(body.inbound_access) }
        : {}),
      updatedAt: timestamp,
      lastActiveAt: timestamp,
    });

    if (!updated) {
      return jsonError("Failed to update agent", 500);
    }

    return NextResponse.json(
      serializeAgentDetail(updated, resolveBaseUrl(request.headers)),
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    console.error("PATCH /api/agents/[id] failed:", error);
    return jsonError("Failed to update agent", 500);
  }
}

async function DELETEUnscoped(_request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const deleted = await deleteAgent(id);

    if (!deleted) {
      return jsonError("Agent not found", 404);
    }

    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    console.error("DELETE /api/agents/[id] failed:", error);
    return jsonError("Failed to delete agent", 500);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
export const PATCH = withFeatureTenant("govern", PATCHUnscoped);
export const DELETE = withFeatureTenant("govern", DELETEUnscoped);
