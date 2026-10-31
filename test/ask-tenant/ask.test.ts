import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleMcpRequest, mcpCallerAllowed } from "@/lib/ask-tenant/mcp";
import {
  answerQuestion,
  ROW_LIMIT,
  runAskTool,
  searchText,
  type AskDeps,
  type SafEventInput,
} from "@/lib/ask-tenant/tools";

function event(name: string, title: string): SafEventInput {
  return {
    id: name,
    receivedAt: "2026-10-31T12:00:00.000Z",
    event: {
      tenant: "beta-25503",
      eventType: "RiskStateChanged",
      identity: { name },
      agent: { name: "FinBot" },
      risk: { severity: "high", status: "high", title },
    },
  };
}

function deps(overrides: Partial<AskDeps> = {}): AskDeps & { searches: string[][] } {
  const searches: string[][] = [];
  return {
    searches,
    tenant: "beta-25503",
    search: async (indices, query) => {
      searches.push([indices.join(","), query]);
      if (indices.includes("identities")) {
        return [
          {
            id: "id-1",
            name: "maya.chen",
            displayName: "Maya Chen",
            attributes: { email: "maya.chen@example.com" },
            extra: "drop me",
          },
        ];
      }
      if (indices.includes("events")) {
        return [{ id: "ev-1", created: "2026-10-01T00:00:00.000Z", action: "Access Request", actor: { name: "Maya Chen" } }];
      }
      return [{ id: "ent-1", name: "SAF Admin", source: { name: "ISC Admins" }, description: "long" }];
    },
    safEvents: async () => [event("Maya Chen", "Maya Chen risk changed"), event("Luis Stone", "Luis Stone risk changed")],
    ...overrides,
  };
}

describe("ask tenant", () => {
  it("names the tenant and keeps the read on identities", async () => {
    const client = deps();
    const result = await answerQuestion("which identities are named Maya", client);
    assert.equal(result.refused, false);
    assert.equal(result.tenant, "beta-25503");
    assert.match(result.answer, /On tenant beta-25503/);
    assert.match(result.answer, /Maya Chen <maya\.chen@example\.com>/);
    assert.equal(result.reads.length, 1);
    assert.equal(result.reads[0]?.tool, "search_identities");
    assert.deepEqual(result.reads[0]?.rows[0], {
      id: "id-1",
      name: "maya.chen",
      displayName: "Maya Chen",
      email: "maya.chen@example.com",
      identityStatus: undefined,
    });
    assert.deepEqual(client.searches, [["identities", "Maya"]]);
  });

  it("refuses a change and does not call the tenant", async () => {
    const client = deps();
    const result = await answerQuestion("delete the admin role", client);
    assert.equal(result.refused, true);
    assert.match(result.answer, /Only read-only questions are allowed on tenant beta-25503/);
    assert.equal(client.searches.length, 0);
  });

  it("caps each read at the row limit", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `id-${index}`, name: `user${index}` }));
    const result = await answerQuestion("list identities", {
      ...deps(),
      search: async () => rows,
    });
    assert.equal(result.reads[0]?.rows.length, ROW_LIMIT);
    assert.equal(result.reads[0]?.truncated, true);
    assert.match(result.answer, /limit reached/);
  });

  it("reads access, audit, and stored SAF events for one question", async () => {
    const client = deps();
    const result = await answerQuestion("what access changed for Maya in SAF", client);
    const tools = result.reads.map((read) => read.tool);
    assert.deepEqual(tools, ["list_saf_events", "search_audit_events", "search_access"]);
    assert.match(result.answer, /SAF Admin \(ISC Admins\)/);
    assert.match(result.answer, /Access Request by Maya Chen/);
    assert.match(result.answer, /Maya Chen risk changed/);
    assert.doesNotMatch(result.answer, /Luis Stone/);
  });

  it("answers from stored SAF events when no tenant is connected", async () => {
    const result = await answerQuestion("show SAF events", {
      tenant: null,
      search: async () => {
        throw new Error("should not search");
      },
      safEvents: async () => [event("Maya Chen", "Maya Chen risk changed")],
    });
    assert.match(result.answer, /No ISC tenant is connected/);
    assert.match(result.answer, /Maya Chen risk changed/);
  });

  it("keeps a quoted name as the search text", () => {
    assert.equal(searchText('who is "Maya Chen"'), "Maya Chen");
  });

  it("refuses a write sent straight to a tool", async () => {
    const client = deps();
    const read = await runAskTool("search_identities", "delete maya", client);
    assert.match(read.error ?? "", /beta-25503/);
    assert.equal(client.searches.length, 0);
  });
});

describe("ask tenant mcp", () => {
  it("allows a signed-in session or a matching worker token", () => {
    const matches = (value: string | null) => value === "worker-token";
    assert.equal(mcpCallerAllowed("mo", null, null, matches), true);
    assert.equal(mcpCallerAllowed(null, "worker-token", null, matches), true);
    assert.equal(mcpCallerAllowed(null, null, "Bearer worker-token", matches), true);
    assert.equal(mcpCallerAllowed(null, null, null, matches), false);
  });

  it("lists the four read tools", async () => {
    const result = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps());
    const tools = (result.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    );
    assert.deepEqual(tools, [
      "search_identities",
      "search_access",
      "search_audit_events",
      "list_saf_events",
    ]);
  });

  it("answers a tool call with the tenant name", async () => {
    const result = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_identities", arguments: { query: "Maya" } },
      },
      deps(),
    );
    const body = result.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, false);
    assert.match(body.result.content[0]?.text ?? "", /On tenant beta-25503/);
    assert.match(body.result.content[0]?.text ?? "", /Maya Chen/);
  });

  it("refuses a tool call that is not a read", async () => {
    const client = deps();
    const result = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_access", arguments: { query: "grant SAF Admin" } },
      },
      client,
    );
    const body = result.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0]?.text ?? "", /Only read-only questions are allowed on tenant beta-25503/);
    assert.equal(client.searches.length, 0);
  });

  it("ignores the initialized notification", async () => {
    const result = await handleMcpRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      deps(),
    );
    assert.equal(result.status, 202);
    assert.equal(result.body, null);
  });
});
