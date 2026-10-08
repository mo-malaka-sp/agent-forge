import { resetSafEvents } from "@/lib/saf-poc/events";
import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await resetSafEvents();
    return safJson(await safPocResponse(resolveBaseUrl(request.headers)));
  } catch (error) {
    return safError(error);
  }
}
