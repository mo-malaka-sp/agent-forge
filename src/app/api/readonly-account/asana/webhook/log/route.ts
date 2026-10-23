import { defaultWebhookStore } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const state = await defaultWebhookStore().load();
    return safJson({ entries: state?.log ?? [] });
  } catch (error) {
    return safError(error);
  }
}
