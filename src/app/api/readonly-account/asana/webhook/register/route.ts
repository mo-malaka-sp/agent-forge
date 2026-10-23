import { registerReadySectionWebhook, defaultWebhookStore } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
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
