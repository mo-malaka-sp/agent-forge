import { NextResponse, type NextRequest } from "next/server";

import { mcpClientConfig } from "@/lib/ask-tenant/mcp";
import { adminPassword, adminUsername } from "@/lib/auth/credentials";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

// Signed-in download. The file contains the same sign-in used for this app.
export async function GET(request: NextRequest) {
  const mcpUrl = `${resolveBaseUrl(request.headers)}/api/ask-tenant/mcp`;
  return new NextResponse(mcpClientConfig(mcpUrl, adminUsername(), adminPassword()), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ask-this-tenant.mcp.json"',
      "Cache-Control": "no-store",
    },
  });
}
