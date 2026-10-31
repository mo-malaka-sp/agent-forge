import { NextResponse, type NextRequest } from "next/server";

import { handleMcpRequest, mcpCallerAllowed, rpcError, rpcId } from "@/lib/ask-tenant/mcp";
import { liveAskDeps } from "@/lib/ask-tenant/tools";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";

export const runtime = "nodejs";

// Claude calls this without opening the page. The tools use the ISC tenant
// AgentForge is already connected to. A signed-in session or the worker token
// is required. Header x-agentforge-worker or Authorization: Bearer.
async function allowed(request: NextRequest): Promise<boolean> {
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  return mcpCallerAllowed(
    session,
    request.headers.get("x-agentforge-worker"),
    request.headers.get("authorization"),
    workerAuthorized,
  );
}

export async function GET() {
  return NextResponse.json(rpcError(null, -32000, "POST a JSON-RPC message."), {
    status: 405,
    headers: { Allow: "POST", "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  const callerAllowed = await allowed(request);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "Parse error."), {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!callerAllowed) {
    return NextResponse.json(
      rpcError(
        rpcId(payload),
        -32001,
        "Sign in, or send the worker token in x-agentforge-worker or Authorization: Bearer.",
      ),
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const result = await handleMcpRequest(payload, liveAskDeps());
  if (result.body === null) {
    return new NextResponse(null, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
