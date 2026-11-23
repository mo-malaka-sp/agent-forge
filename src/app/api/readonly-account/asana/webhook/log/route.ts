import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { defaultWebhookStore } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

async function GETUnscoped() {
  try {
    const state = await defaultWebhookStore().load();
    return safJson({ entries: state?.log ?? [] });
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant("test-drive", GETUnscoped);
