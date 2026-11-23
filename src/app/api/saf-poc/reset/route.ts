import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { sectionFeature } from "@/lib/saf-poc/section";
import { resetSafEvents } from "@/lib/saf-poc/events";
import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  try {
    await resetSafEvents();
    return safJson(await safPocResponse(resolveBaseUrl(request.headers)));
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant(sectionFeature, POSTUnscoped);
