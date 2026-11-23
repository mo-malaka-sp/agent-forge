import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

async function POSTUnscoped(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return environmentJson({ environment: await environmentService().validate(id) });
  } catch (error) {
    return environmentError(error);
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
