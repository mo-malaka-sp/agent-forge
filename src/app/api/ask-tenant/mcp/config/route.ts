import { NextResponse, type NextRequest } from "next/server";

import { mcpClientConfig } from "@/lib/ask-tenant/mcp";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

// Signed-in download. The file contains the worker token, so it stays off the page.
export async function GET(request: NextRequest) {
  const workerToken = loadSafPocConfig().workerToken;
  if (!workerToken) {
    return safJson(
      { error: "Set SAF_POC_WORKER_TOKEN on this app, then download the file again." },
      400,
    );
  }

  const mcpUrl = `${resolveBaseUrl(request.headers)}/api/ask-tenant/mcp`;
  return new NextResponse(mcpClientConfig(mcpUrl, workerToken), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ask-this-tenant.mcp.json"',
      "Cache-Control": "no-store",
    },
  });
}
