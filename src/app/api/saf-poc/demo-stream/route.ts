import { runSailPointDemoStream } from "@/lib/saf-poc/events";
import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const index = await demoIndex(request);
    const sent = await runSailPointDemoStream(1, index);
    return safJson({
      sent: sent.length,
      state: await safPocResponse(resolveBaseUrl(request.headers)),
    });
  } catch (error) {
    return safError(error);
  }
}

async function demoIndex(request: Request): Promise<number> {
  try {
    const body = (await request.json()) as { index?: unknown };
    if (typeof body.index === "number" && Number.isFinite(body.index) && body.index >= 0) {
      return Math.floor(body.index);
    }
  } catch {
    // A click with no body still sends one log.
  }
  return Date.now();
}
