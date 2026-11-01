import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleMcpRequest, mcpCallerAllowed, mcpClientConfig } from "@/lib/ask-tenant/mcp";
import {
  answerQuestion,
  readAsText,
  ROW_LIMIT,
  runAskTool,
  searchText,
  type AskDeps,
  type SafEventInput,
} from "@/lib/ask-tenant/tools";
import { narrateAgent } from "@/lib/ask-tenant/narrate";
import { agentProfileFields, type AgentRiskSnapshot, type TenantAgent } from "@/lib/saf-poc/tenant-agents";

const AGENTS: TenantAgent[] = [
  {
    id: "agt-1",
    name: "Finance Navigator",
    riskLevel: "High",
    email: "",
    ownerId: "owner-1",
    ownerName: "Dana Lee",
    ownerEmail: "dana.lee@example.com",
    source: "AWS Bedrock - spciem",
    subtype: "Agent",
    agentType: "Agent",
    businessApplication: "Finance",
  },
  {
    id: "agt-2",
    name: "Policy Concierge",
    riskLevel: "Low",
    email: "",
    ownerId: "owner-2",
    ownerName: "Jordan Lee",
    ownerEmail: "jordan.lee@example.com",
    source: "GCP Vertex - spciem",
    subtype: "Agent",
    agentType: "Agent",
    businessApplication: "Policy",
  },
];

const AGENT_FINDINGS: Record<string, AgentRiskSnapshot> = {
  "agt-1": {
    calculatedSeverity: "High",
    findings: [{ title: "Excessive outbound access", detectedAt: "2026-10-20T00:00:00.000Z" }],
    findingsNote: "",
    profile: [
      { label: "Description", value: "Answers finance questions" },
      { label: "Tools", value: "cortex_analyst, sql_exec" },
    ],
  },
  "agt-2": {
    calculatedSeverity: "Low",
    findings: [],
    findingsNote: "SailPoint returned no findings for this agent.",
  },
};

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
    listAgents: async () => AGENTS,
    agentFindings: async (agentId) => {
      const snapshot = AGENT_FINDINGS[agentId];
      if (!snapshot) {
        throw new Error(`No findings fixture for ${agentId}.`);
      }
      return snapshot;
    },
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
    const rows = Array.from({ length: ROW_LIMIT + 1 }, (_, index) => ({ id: `id-${index}`, name: `user${index}` }));
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

  it("matches agents by source when the question says use Snowflake", async () => {
    const client = deps();
    const snowflake: TenantAgent = {
      ...AGENTS[0],
      id: "agt-snow",
      name: "FINANCE_OPERATIONS_SUPERVISOR",
      source: "Snowflake SaaS",
      ownerName: "nate.mcqueen",
    };
    client.listAgents = async () => [snowflake, AGENTS[1]];
    const result = await answerQuestion("Which agents use Snowflake?", client);
    assert.equal(result.reads[0]?.query, "Snowflake");
    assert.match(result.answer, /FINANCE_OPERATIONS_SUPERVISOR/);
    assert.doesNotMatch(result.answer, /Policy Concierge/);
  });

  it("lists SAF agents instead of identities for a plain agent question", async () => {
    const client = deps();
    const result = await answerQuestion("List the AI Agents", client);
    assert.deepEqual(result.reads.map((read) => read.tool), ["list_agents"]);
    assert.match(result.answer, /SAF agents matching the newest rows \(2\):/);
    assert.match(result.answer, /Finance Navigator — High risk \(AWS Bedrock - spciem\) owner Dana Lee/);
    assert.match(result.answer, /Policy Concierge — Low risk \(GCP Vertex - spciem\) owner Jordan Lee/);
    assert.doesNotMatch(result.answer, /Identities matching/);
  });

  it("describes an agent's stored fields and findings when asked about capabilities", async () => {
    const client = deps();
    const result = await answerQuestion('What are "Finance Navigator" capabilities?', client);
    assert.deepEqual(result.reads.map((read) => read.tool), ["describe_agent"]);
    assert.match(result.answer, /Finance Navigator is a high-risk agent on AWS Bedrock - spciem, owned by Dana Lee/);
    assert.match(result.answer, /Answers finance questions/);
    assert.match(result.answer, /tools cortex_analyst, sql_exec/);
    assert.match(result.answer, /Excessive outbound access \(detected 2026-10-20/);
    assert.doesNotMatch(result.answer, /Description:/);
    assert.doesNotMatch(result.answer, /Policy Concierge/);
  });

  it("answers agent features with details only, not a second agent list", async () => {
    const client = deps();
    const result = await answerQuestion("What features do the agents have?", client);
    assert.deepEqual(result.reads.map((read) => read.tool), ["describe_agent"]);
    assert.doesNotMatch(result.answer, /SAF agents matching/);
    assert.doesNotMatch(result.answer, /limit reached/);
  });

  it("says which agents were skipped instead of reporting a row limit", async () => {
    const many: TenantAgent[] = Array.from({ length: 6 }, (_, index) => ({
      ...AGENTS[1],
      id: `agt-many-${index}`,
      name: `Agent ${index}`,
    }));
    const result = await answerQuestion("What features do the agents have?", deps({ listAgents: async () => many }));
    assert.match(result.answer, /Showing the first 5 of 6 agents/);
    assert.doesNotMatch(result.answer, /limit reached/);
  });

  it("reads stored agent fields without ids, owners, or secrets", () => {
    const fields = agentProfileFields({
      id: "agt-1",
      name: "FINANCE_OPERATIONS_SUPERVISOR",
      description: "Supervises finance agents",
      created: "2026-09-01T00:00:00.000Z",
      owners: { primaryIdentity: { name: "nate.mcqueen" } },
      sourceId: "src-1",
      userEntitlements: [{ displayName: "SNOWFLAKE_FINANCE_READ" }, { displayName: "CORTEX_USER" }],
      attributes: {
        model: "claude-sonnet",
        tools: ["cortex_analyst", { name: "sql_exec" }],
        apiToken: "do-not-show",
        warehouseId: "wh-1",
        emptyList: [],
      },
    });
    assert.deepEqual(fields, [
      { label: "Description", value: "Supervises finance agents" },
      { label: "Created", value: "2026-09-01T00:00:00.000Z" },
      { label: "User entitlements", value: "SNOWFLAKE_FINANCE_READ, CORTEX_USER" },
      { label: "Model", value: "claude-sonnet" },
      { label: "Tools", value: "cortex_analyst, sql_exec" },
    ]);
  });

  it("writes one agent answer instead of repeating every stored field", () => {
    const answer = narrateAgent({
      name: "POLICY_CONCIERGE",
      riskLevel: "Medium",
      source: "Snowflake SaaS",
      owner: "mo.malaka",
      findings: [],
      findingsNote: "SailPoint returned no findings for this agent.",
      details: [
        {
          label: "Description",
          value:
            "Answers employee questions from the approved synthetic policy corpus. Search only: no eligibility decisions and no actions.",
        },
        { label: "Manually created", value: "false" },
        { label: "Subtype", value: "AI Agent" },
        { label: "Native identity", value: "AGENT_GOVERNANCE_DEMO.DEMO.POLICY_CONCIERGE" },
        { label: "User entitlements", value: "POLICY_CONCIERGE_USERS" },
        { label: "Business application refs", value: "Snowflake Cortex" },
        { label: "Effective sanctioned status", value: "SANCTIONED" },
        { label: "Name", value: "POLICY_CONCIERGE" },
        { label: "Model", value: "auto" },
        { label: "Roles", value: "AGENT_DEMO_DEPLOYER, AGENT_POLICY_RUNTIME, POLICY_CONCIERGE_USERS" },
        { label: "Comment", value: "Answers employee questions from the approved synthetic policy corpus." },
        { label: "Profile", value: '{"display_name":"Policy Concierge","color":"blue"}' },
        {
          label: "Instructions",
          value:
            '{"response":"You are Policy Concierge. Answer only from retrieved policy text. Cite the policy title. Do not infer employee-specific eligibility and do not take actions.","orchestration":"...',
        },
        { label: "Sp description", value: "Answers employee questions from the approved synthetic policy corpus." },
        { label: "Sp business application", value: "snowflake.cortex" },
        { label: "Status", value: "Active" },
        { label: "Agent type", value: "Enterprise" },
      ],
    });
    assert.match(answer, /POLICY_CONCIERGE is a medium-risk enterprise agent on Snowflake SaaS, owned by mo.malaka/);
    assert.match(answer, /It is active and sanctioned/);
    assert.match(answer, /approved synthetic policy corpus/);
    assert.match(answer, /Answer only from retrieved policy text/);
    assert.match(answer, /model auto/);
    assert.match(answer, /Snowflake Cortex/);
    assert.match(answer, /AGENT_POLICY_RUNTIME/);
    assert.match(answer, /no findings/);
    assert.equal(answer.split("approved synthetic policy corpus").length - 1, 1);
    assert.doesNotMatch(answer, /Description:|Manually created|display_name|snowflake\.cortex/);
  });

  it("notes no findings and no stored fields for a clean agent", async () => {
    const client = deps();
    const read = await runAskTool("describe_agent", "Policy Concierge", client);
    assert.equal(read.rows.length, 1);
    assert.equal(read.rows[0]?.name, "Policy Concierge");
    assert.deepEqual(read.rows[0]?.findings, []);
    const text = readAsText(read);
    assert.match(text, /Policy Concierge is a low-risk agent on GCP Vertex - spciem, owned by Jordan Lee/);
    assert.match(text, /SailPoint stores no description of what it does/);
    assert.match(text, /SailPoint returned no findings for this agent/);
    assert.doesNotMatch(text, /Description:/);
  });

  it("requires a connected tenant for agent tools", async () => {
    const result = await answerQuestion("List the AI Agents", {
      tenant: null,
      search: async () => {
        throw new Error("should not search");
      },
      safEvents: async () => [],
      listAgents: async () => {
        throw new Error("should not list agents");
      },
      agentFindings: async () => {
        throw new Error("should not describe agents");
      },
    });
    assert.match(result.answer, /Connect an ISC tenant before asking/);
  });
});

describe("ask tenant mcp", () => {
  it("builds an MCP config with the AgentForge sign-in", () => {
    const config = JSON.parse(
      mcpClientConfig("https://agentforge.example/api/ask-tenant/mcp", "agentforge", "secret"),
    ) as {
      mcpServers: {
        "ask-this-tenant": { url: string; headers: { Authorization: string } };
      };
    };
    assert.equal(
      config.mcpServers["ask-this-tenant"].url,
      "https://agentforge.example/api/ask-tenant/mcp",
    );
    assert.equal(
      config.mcpServers["ask-this-tenant"].headers.Authorization,
      `Basic ${Buffer.from("agentforge:secret").toString("base64")}`,
    );
  });

  it("accepts the same username and password as the app sign-in", () => {
    const authorization = `Basic ${Buffer.from("agentforge:secret").toString("base64")}`;
    const matches = (username: string, password: string) =>
      username === "agentforge" && password === "secret";
    assert.equal(mcpCallerAllowed(null, null, authorization, () => false, matches), true);
    assert.equal(
      mcpCallerAllowed(null, null, "Basic bm90Om1l", () => false, matches),
      false,
    );
  });

  it("allows a signed-in session or a matching worker token", () => {
    const matches = (value: string | null) => value === "worker-token";
    assert.equal(mcpCallerAllowed("mo", null, null, matches), true);
    assert.equal(mcpCallerAllowed(null, "worker-token", null, matches), true);
    assert.equal(mcpCallerAllowed(null, null, "Bearer worker-token", matches), true);
    assert.equal(mcpCallerAllowed(null, null, null, matches), false);
  });

  it("lists the six read tools", async () => {
    const result = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps());
    const tools = (result.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    );
    assert.deepEqual(tools, [
      "search_identities",
      "search_access",
      "search_audit_events",
      "list_saf_events",
      "list_agents",
      "describe_agent",
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

  it("answers a list_agents tool call", async () => {
    const result = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_agents", arguments: {} },
      },
      deps(),
    );
    const body = result.body as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, false);
    assert.match(body.result.content[0]?.text ?? "", /Finance Navigator — High risk/);
    assert.match(body.result.content[0]?.text ?? "", /Policy Concierge — Low risk/);
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
