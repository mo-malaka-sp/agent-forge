import {
  ASK_TOOL_NAMES,
  readAsText,
  ROW_LIMIT,
  runAskTool,
  type AskDeps,
  type AskToolName,
} from "@/lib/ask-tenant/tools";

const PROTOCOL_VERSION = "2025-03-26";

const TOOL_DESCRIPTIONS: Record<AskToolName, string> = {
  search_identities:
    "Read identities on the ISC tenant AgentForge is connected to. One tenant, at most 25 rows.",
  search_access:
    "Read entitlements, roles, and access profiles on the connected ISC tenant. At most 25 rows.",
  search_audit_events:
    "Read audit events on the connected ISC tenant. At most 25 rows.",
  list_saf_events:
    "Read SAF risk and CAEP events already stored in AgentForge. At most 25 rows.",
  list_agents:
    "Read the SAF agent identities registered on the connected ISC tenant: name, risk level, owner, source, and business application. At most 25 rows.",
  describe_agent:
    "Read one or more SAF agents' risk severity and detected findings on the connected ISC tenant. Matches up to 5 agents by name. At most 25 rows.",
};

export interface McpHttpResult {
  status: number;
  body: unknown | null;
}

export function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(\S+)/i);
  return match?.[1] ?? null;
}

export function mcpCallerAllowed(
  sessionUser: string | null,
  workerHeader: string | null,
  authorizationHeader: string | null,
  workerMatches: (value: string | null) => boolean,
): boolean {
  if (sessionUser) {
    return true;
  }
  if (workerMatches(workerHeader)) {
    return true;
  }
  return workerMatches(bearerToken(authorizationHeader));
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function messageId(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return null;
  }
  return "id" in message ? (message as { id?: unknown }).id : null;
}

function toolSchema() {
  return {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: `Search text. Use * for the newest rows. At most ${ROW_LIMIT} rows are returned.`,
      },
    },
    additionalProperties: false,
  };
}

function toolList() {
  return ASK_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: toolSchema(),
  }));
}

async function handleMessage(message: unknown, deps: AskDeps): Promise<McpHttpResult> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { status: 400, body: rpcError(null, -32600, "Invalid request.") };
  }
  const record = message as { id?: unknown; method?: unknown; params?: unknown };
  const id = record.id;
  const method = typeof record.method === "string" ? record.method : "";
  const notification = !("id" in record);

  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  if (!method) {
    return { status: 400, body: rpcError(id, -32600, "Invalid request.") };
  }
  if (method === "initialize") {
    const params = record.params as { protocolVersion?: unknown } | undefined;
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: requested || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentforge-ask-tenant", version: "1.0.0" },
        instructions:
          "Read-only tools for the one ISC tenant AgentForge is connected to. Each call returns at most 25 rows. These tools cannot create, change, or delete data.",
      }),
    };
  }
  if (method === "ping") {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === "tools/list") {
    return { status: 200, body: rpcResult(id, { tools: toolList() }) };
  }
  if (method === "tools/call") {
    const params = record.params as { name?: unknown; arguments?: unknown } | undefined;
    const name = typeof params?.name === "string" ? params.name : "";
    const args = params?.arguments;
    const query =
      args && typeof args === "object" && !Array.isArray(args) && typeof (args as { query?: unknown }).query === "string"
        ? (args as { query: string }).query
        : undefined;
    if (!ASK_TOOL_NAMES.includes(name as AskToolName)) {
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: "text", text: `Unknown tool ${name}.` }],
          isError: true,
        }),
      };
    }
    const read = await runAskTool(name, query, deps);
    return {
      status: 200,
      body: rpcResult(id, {
        content: [{ type: "text", text: readAsText(read) }],
        isError: Boolean(read.error),
      }),
    };
  }
  if (notification) {
    return { status: 202, body: null };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}.`) };
}

export async function handleMcpRequest(body: unknown, deps: AskDeps): Promise<McpHttpResult> {
  if (Array.isArray(body)) {
    const responses: unknown[] = [];
    for (const item of body) {
      const result = await handleMessage(item, deps);
      if (result.body !== null) {
        responses.push(result.body);
      }
    }
    if (responses.length === 0) {
      return { status: 202, body: null };
    }
    return { status: 200, body: responses };
  }
  return handleMessage(body, deps);
}

export function rpcId(body: unknown): unknown {
  if (Array.isArray(body)) {
    return messageId(body[0]);
  }
  return messageId(body);
}

export { rpcError };
