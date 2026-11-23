import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { getAgentConditionRun } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETUnscoped(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? undefined;
    return safJson({ run: await getAgentConditionRun(id) });
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant("endpoint", GETUnscoped);
