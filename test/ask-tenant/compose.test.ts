import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { askTenantModelId } from "@/lib/ask-tenant/bedrock";
import {
  answerAskedQuestion,
  bedrockToolSpecs,
  composeAnswer,
  readModelResponse,
  type AskConverse,
  type AskModelResponse,
} from "@/lib/ask-tenant/compose";
import { ASK_TOOL_NAMES, type AskDeps } from "@/lib/ask-tenant/tools";
import type { TenantAgent } from "@/lib/saf-poc/tenant-agents";

const AGENT: TenantAgent = {
  id: "agt-1",
  name: "FINANCE_OPERATIONS_SUPERVISOR",
  riskLevel: "Unknown",
  email: "",
  ownerId: "",
  ownerName: "nate.mcqueen",
  ownerEmail: "",
  source: "Snowflake SaaS",
  subtype: "Agent",
  agentType: "Enterprise",
  businessApplication: "Snowflake Cortex",
};

function deps(): AskDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tenant: "company23069-poc",
    search: async () => [],
    safEvents: async () => [],
    listAgents: async () => {
      calls.push("list_agents");
      return [AGENT];
    },
    agentFindings: async () => ({
      calculatedSeverity: "Unknown",
      findings: [],
      findingsNote: "SailPoint returned no findings for this agent.",
    }),
  };
}

describe("ask tenant model", () => {
  it("offers the same six tools as the MCP", () => {
    assert.deepEqual(
      bedrockToolSpecs().map((tool) => tool.name),
      [...ASK_TOOL_NAMES],
    );
    assert.match(bedrockToolSpecs()[0]?.description ?? "", /identities/);
  });

  it("reads a Bedrock tool call for one of those tools", () => {
    const response = readModelResponse([
      { text: "I will look up the agents." },
      { toolUse: { toolUseId: "call-1", name: "list_agents", input: { query: "Snowflake" } } },
    ]);
    assert.equal(response.text, "I will look up the agents.");
    assert.deepEqual(response.tools, [{ id: "call-1", name: "list_agents", query: "Snowflake" }]);
  });

  it("runs the tool the model picks through the same read path as MCP", async () => {
    const client = deps();
    let rounds = 0;
    const converse: AskConverse = async () => {
      rounds += 1;
      if (rounds === 1) {
        return { text: "", tools: [{ id: "call-1", name: "list_agents", query: "Snowflake" }] };
      }
      return { text: "One Snowflake agent: FINANCE_OPERATIONS_SUPERVISOR, owned by nate.mcqueen.", tools: [] };
    };
    const result = await composeAnswer("Which agents use Snowflake?", client, converse);
    assert.deepEqual(client.calls, ["list_agents"]);
    assert.equal(result.reads[0]?.tool, "list_agents");
    assert.equal(result.reads[0]?.query, "Snowflake");
    assert.match(result.answer, /FINANCE_OPERATIONS_SUPERVISOR/);
    assert.equal(result.refused, false);
  });

  it("removes model thinking from the displayed answer", async () => {
    const converse: AskConverse = async () => ({
      text: "<thinking>Internal reasoning.</thinking>\nPOLICY_CONCIERGE answers policy questions.",
      tools: [],
    });
    const result = await composeAnswer("What can POLICY_CONCIERGE do?", deps(), converse);
    assert.equal(result.answer, "POLICY_CONCIERGE answers policy questions.");
  });

  it("normalizes a full agent question supplied as a tool query", async () => {
    const client = deps();
    let rounds = 0;
    const converse: AskConverse = async () => {
      rounds += 1;
      if (rounds === 1) {
        return {
          text: "",
          tools: [
            {
              id: "call-1",
              name: "describe_agent",
              query: "What can FINANCE_OPERATIONS_SUPERVISOR do, and what can it not do?",
            },
          ],
        };
      }
      return { text: "It is a finance supervisor.", tools: [] };
    };
    const result = await composeAnswer(
      "What can FINANCE_OPERATIONS_SUPERVISOR do, and what can it not do?",
      client,
      converse,
    );
    assert.equal(result.reads[0]?.query, "FINANCE_OPERATIONS_SUPERVISOR");
    assert.equal(result.reads[0]?.rows[0]?.name, "FINANCE_OPERATIONS_SUPERVISOR");
  });

  it("refuses a write before the model is called", async () => {
    let called = false;
    const converse: AskConverse = async () => {
      called = true;
      return { text: "no", tools: [] };
    };
    const result = await composeAnswer("delete the admin role", deps(), converse);
    assert.equal(called, false);
    assert.equal(result.refused, true);
    assert.match(result.answer, /company23069-poc/);
  });

  it("falls back to keyword routing when the model call fails", async () => {
    const converse: AskConverse = async () => {
      throw new Error("Bedrock unavailable");
    };
    const result = await answerAskedQuestion("List the AI Agents", deps(), converse);
    assert.match(result.answer, /FINANCE_OPERATIONS_SUPERVISOR/);
    assert.match(result.answer, /company23069-poc/);
    assert.equal(result.answerSource, "fallback");
    assert.match(result.modelError ?? "", /Bedrock unavailable/);
  });

  it("keeps keyword routing when no model is configured", async () => {
    const result = await answerAskedQuestion("List the AI Agents", deps(), null);
    assert.match(result.answer, /SAF agents matching/);
    assert.equal(result.answerSource, "keyword");
  });

  it("stops after four tool calls", async () => {
    const client = deps();
    const converse: AskConverse = async (turn) => {
      if (!turn.toolsEnabled) {
        return { text: "Stopped.", tools: [] };
      }
      const response: AskModelResponse = {
        text: "",
        tools: [1, 2, 3].map((index) => ({ id: `call-${turn.messages.length}-${index}`, name: "list_agents", query: "*" })),
      };
      return response;
    };
    const result = await composeAnswer("List the AI Agents", client, converse);
    assert.equal(result.reads.length, 4);
    assert.equal(result.answer, "Stopped.");
  });

  it("uses the Nova Lite id when the env value is default", () => {
    const previous = process.env.ASK_TENANT_MODEL_ID;
    process.env.ASK_TENANT_MODEL_ID = "default";
    assert.equal(askTenantModelId(), "us.amazon.nova-lite-v1:0");
    process.env.ASK_TENANT_MODEL_ID = "anthropic.claude-3-haiku";
    assert.equal(askTenantModelId(), "anthropic.claude-3-haiku");
    if (previous === undefined) {
      delete process.env.ASK_TENANT_MODEL_ID;
    } else {
      process.env.ASK_TENANT_MODEL_ID = previous;
    }
    assert.equal(askTenantModelId(), previous?.trim() || null);
  });

});
