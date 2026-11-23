import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";

import { resetDemoData } from "@/lib/demo/reset";
import { demoResetSchema } from "@/lib/validation/demo.schema";

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  try {
    const body = demoResetSchema.parse(
      await request.json().catch(() => ({})),
    );

    const result = resetDemoData({
      scope: body.scope,
      agentId: body.agent_id,
      removeBulkAgents: body.remove_bulk_agents,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Demo reset failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
