import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

async function GETUnscoped(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return environmentJson({ agents: await environmentService().discover(id) });
  } catch (error) {
    return environmentError(error);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
