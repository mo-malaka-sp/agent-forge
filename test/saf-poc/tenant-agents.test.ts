import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";
import { listTenantAgents, parseTenantAgents, selectTenantAgents } from "@/lib/saf-poc/tenant-agents";

function config(): SailPointSetupConfig {
  return {
    tenant: "beta-25503",
    apiBase: "https://beta-25503.api.identitynow-demo.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "admin@example.com",
  };
}

describe("tenant agents", () => {
  it("keeps AI agents when the tenant also returns other machine identities", () => {
    const agents = parseTenantAgents([
      {
        id: "agent-1",
        name: "Bedrock reviewer",
        subtype: "AI Agent",
        attributes: { riskLevel: "HIGH" },
        source: { name: "AI Agents Bedrock" },
      },
      { id: "app-1", name: "Payroll", subtype: "Application" },
      { id: "", name: "missing id" },
    ]);
    const selected = selectTenantAgents(agents);
    assert.deepEqual(
      selected.map((agent) => agent.name),
      ["Bedrock reviewer"],
    );
    assert.equal(selected[0]?.riskLevel, "High");
    assert.equal(selected[0]?.source, "AI Agents Bedrock");
  });

  it("lists machine identities from the tenant", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("/v2026/machine-identities")) {
        return Response.json([
          {
            id: "mi-1",
            name: "Foundry assistant",
            attributes: { subtype: "AI Agent", risk_level: "low" },
          },
        ]);
      }
      return new Response("missing", { status: 404 });
    };

    const agents = await listTenantAgents(config(), fetchImpl);
    assert.equal(agents[0]?.id, "mi-1");
    assert.equal(agents[0]?.riskLevel, "Low");
    assert.equal(
      calls.some((call) => call.includes("/v2026/machine-identities?limit=250&offset=0")),
      true,
    );
  });

  it("falls back to the previous machine identity API", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("/v2026/machine-identities")) {
        return new Response("missing", { status: 404 });
      }
      if (String(url).includes("/v2025/machine-identities")) {
        return Response.json([{ id: "mi-old", businessApplication: "Legacy agent" }]);
      }
      return new Response("missing", { status: 404 });
    };

    const agents = await listTenantAgents(config(), fetchImpl);
    assert.equal(agents[0]?.name, "Legacy agent");
  });
});
