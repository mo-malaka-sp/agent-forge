import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { sectionFeature } from "@/lib/saf-poc/section";
import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

async function GETUnscoped(request: Request) {
  try {
    return safJson(await safPocResponse(resolveBaseUrl(request.headers)));
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant(sectionFeature, GETUnscoped);
