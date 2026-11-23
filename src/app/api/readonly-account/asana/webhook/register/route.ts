import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { registerReadySectionWebhook, defaultWebhookStore } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  try {
    const targetUrl = `${resolveBaseUrl(request.headers)}/api/readonly-account/asana/webhook`;
    return safJson(
      await registerReadySectionWebhook({
        targetUrl,
        store: defaultWebhookStore(),
      }),
    );
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
