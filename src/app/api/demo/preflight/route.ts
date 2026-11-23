import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";

import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { runDemoPreflight } from "@/lib/demo/preflight";
import { demoPreflightQuerySchema } from "@/lib/validation/demo.schema";

export const runtime = "nodejs";

async function handlePreflight(request: Request, raw: Record<string, unknown>) {
  const query = demoPreflightQuerySchema.parse(raw);

  return withRequestIscRuntime(request, query, async () =>
    runDemoPreflight(query.mode, {
      agentId: query.agent_id,
      allowPermission: query.allow_permission,
      revokeEntitlement: query.revoke_entitlement,
      principal: query.principal,
      deploymentProvider: query.deployment_provider,
    }),
  );
}

async function GETUnscoped(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const result = await handlePreflight(request, {
      mode: searchParams.get("mode"),
      agent_id: searchParams.get("agent_id") ?? undefined,
      allow_permission: searchParams.get("allow_permission") ?? undefined,
      revoke_entitlement: searchParams.get("revoke_entitlement") ?? undefined,
      principal: searchParams.get("principal") ?? undefined,
      deployment_provider: searchParams.get("deployment_provider") ?? undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preflight check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

async function POSTUnscoped(request: Request) {
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const result = await handlePreflight(request, raw);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Preflight check failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
export const POST = withFeatureTenant("govern", POSTUnscoped);
