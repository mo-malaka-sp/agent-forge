import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { configurationDocument } from "@/lib/saf-poc/transmitter";
import { safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

async function GETUnscoped(request: Request) {
  return safJson(configurationDocument(resolveBaseUrl(new Headers(request.headers))));
}

export const GET = withFeatureTenant("caep", GETUnscoped);
