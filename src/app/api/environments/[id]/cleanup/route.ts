import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

async function POSTUnscoped(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    const result = await environmentService().requestCleanup(id, body.confirm ?? "");
    return environmentJson(result, result.accepted ? 202 : 400);
  } catch (error) {
    return environmentError(error);
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
