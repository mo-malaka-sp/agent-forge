import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { jsonError } from "@/lib/api/response";
import { loadPreparedSpConfig } from "@/lib/isc/sp-config-package";
import { resolveBaseUrl } from "@/lib/url";

interface RouteContext {
  params: Promise<{ platform: string }>;
}

async function GETUnscoped(request: Request, context: RouteContext) {
  try {
    const { platform } = await context.params;
    const baseUrl = resolveBaseUrl(request.headers);
    const prepared = await loadPreparedSpConfig(platform, baseUrl);

    if (!prepared) {
      return jsonError(
        `Golden SP-Config for "${platform}" is not published yet.`,
        404,
      );
    }

    return new Response(prepared.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${prepared.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("ISC SP-Config download failed:", error);
    return jsonError("Could not prepare SP-Config download", 500);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
