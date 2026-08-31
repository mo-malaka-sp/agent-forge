import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api/response";
import { getSpConfigPlatformStatuses } from "@/lib/isc/sp-config-package";
import { isUnreachableBaseUrl } from "@/lib/isc/source-base-url";
import { resolveBaseUrl } from "@/lib/url";

export async function GET(request: Request) {
  try {
    const platforms = await getSpConfigPlatformStatuses();
    const baseUrl = resolveBaseUrl(request.headers);
    const allAvailable = platforms.every((platform) => platform.available);

    return NextResponse.json({
      baseUrl,
      baseUrlReachable: !isUnreachableBaseUrl(baseUrl),
      allAvailable,
      importGuideUrl:
        "https://documentation.sailpoint.com/saas/help/confighub/confighub_import.html",
      vscodeExtensionUrl:
        "https://marketplace.visualstudio.com/items?itemName=yannick-beot-sp.vscode-sailpoint-identitynow",
      platforms,
    });
  } catch (error) {
    console.error("ISC SP-Config status failed:", error);
    return jsonError("Could not load golden SP-Config package", 500);
  }
}
