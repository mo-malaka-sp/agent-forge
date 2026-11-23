import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { safError, safJson } from "@/lib/saf-poc/http";
import { startAgentConditionRun } from "@/lib/saf-poc/agent-condition";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  try {
    const body = (await request.json()) as { agentId?: string; confirmed?: boolean };
    const run = await startAgentConditionRun({
      agentId: body.agentId?.trim() ?? "",
      confirmed: body.confirmed === true,
      publicUrl: resolveBaseUrl(request.headers),
    });
    return safJson({ run }, 202);
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("endpoint", POSTUnscoped);
