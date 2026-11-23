import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { safError, safJson } from "@/lib/saf-poc/http";
import { readApiToken } from "@/lib/saf-poc/transmitter";

export const runtime = "nodejs";

async function GETUnscoped() {
  try {
    return safJson({ token: await readApiToken() });
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant("caep", GETUnscoped);
