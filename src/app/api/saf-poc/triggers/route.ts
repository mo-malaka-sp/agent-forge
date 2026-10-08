import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { safError, safJson } from "@/lib/saf-poc/http";
import { createSailPointClient } from "@/lib/saf-poc/sailpoint";

export const runtime = "nodejs";

export async function GET() {
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
