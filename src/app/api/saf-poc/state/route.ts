import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return safJson(await safPocResponse(resolveBaseUrl(request.headers)));
  } catch (error) {
    return safError(error);
  }
}
