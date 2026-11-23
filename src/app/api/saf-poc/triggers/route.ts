import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { safError, safJson } from "@/lib/saf-poc/http";
import { createSailPointClient } from "@/lib/saf-poc/sailpoint";

export const runtime = "nodejs";

async function GETUnscoped() {
  try {
    const config = loadSafPocConfig();
    const triggers = await createSailPointClient(config).listTriggers();
    return safJson({
      tenant: config.tenant,
      triggerName: config.triggerName,
      triggers,
    });
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant("caep", GETUnscoped);
