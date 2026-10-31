import { NextResponse, type NextRequest } from "next/server";

import { handleMcpRequest, mcpCallerAllowed, rpcError, rpcId } from "@/lib/ask-tenant/mcp";
import { liveAskDeps } from "@/lib/ask-tenant/tools";
import { credentialsMatch } from "@/lib/auth/credentials";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";

export const runtime = "nodejs";

// A chat app is not signed in through the browser. It sends the same
// AgentForge username and password as HTTP Basic auth.
async function allowed(request: NextRequest): Promise<boolean> {
  const session = await readSession(request.cookies.get(SESSION_COOKIE)?.value);
  return mcpCallerAllowed(
    session,
    request.headers.get("x-agentforge-worker"),
    request.headers.get("authorization"),
    workerAuthorized,
    credentialsMatch,
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
        "Sign in with the AgentForge username and password.",
      ),
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const result = await withRequestIscRuntime(request, undefined, () =>
    handleMcpRequest(payload, liveAskDeps()),
  );
  if (result.body === null) {
    return new NextResponse(null, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
