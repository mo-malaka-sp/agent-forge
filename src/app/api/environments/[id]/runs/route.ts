import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

async function POSTUnscoped(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { repair?: boolean };
    return environmentJson(
      { run: await environmentService().startRun(id, Boolean(body.repair)) },
      201,
    );
  } catch (error) {
    return environmentError(error);
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
