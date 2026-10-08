import { configurationDocument } from "@/lib/saf-poc/transmitter";
import { safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return safJson(configurationDocument(resolveBaseUrl(new Headers(request.headers))));
}
