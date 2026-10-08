import { ingestSafEvent } from "@/lib/saf-poc/events";
import { safError, safJson, webhookAuthorized } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!webhookAuthorized(request.headers.get("x-saf-webhook-token"))) {
      return safJson({ error: "Webhook token is invalid." }, 401);
    }
    const text = await request.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return safJson({ error: "Request body must be valid JSON." }, 400);
    }
    return safJson(await ingestSafEvent({ payload, source: "webhook" }), 202);
  } catch (error) {
    return safError(error);
  }
}
