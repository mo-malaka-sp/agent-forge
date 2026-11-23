import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";
import type { CreateEnvironmentInput } from "@/lib/environments/types";

export const runtime = "nodejs";

async function GETUnscoped() {
  try {
    return environmentJson({ environments: await environmentService().list() });
  } catch (error) {
    return environmentError(error);
  }
}

async function POSTUnscoped(request: Request) {
  try {
    const body = (await request.json()) as CreateEnvironmentInput;
    return environmentJson({ environment: await environmentService().create(body) }, 201);
  } catch (error) {
    return environmentError(error);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
export const POST = withFeatureTenant("govern", POSTUnscoped);
