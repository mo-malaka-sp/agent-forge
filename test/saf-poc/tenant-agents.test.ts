import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";
import {
  listTenantAgents,
  parseTenantAgents,
  selectTenantAgents,
  updateTenantAgentRisk,
} from "@/lib/saf-poc/tenant-agents";

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
        owners: {
          primaryIdentity: {
            id: "owner-1",
            name: "mo.malaka",
            email: "Mo.Malaka@sailpoint.com",
          },
        },
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
    assert.equal(selected[0]?.ownerEmail, "mo.malaka@sailpoint.com");
    assert.equal(selected[0]?.ownerName, "mo.malaka");
  });

  it("lists machine identities from the current Human Fabric API", async () => {
    const calls: Array<{ url: string; experimental: string | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        experimental: headers.get("X-SailPoint-Experimental"),
      });
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("/machine-identities/v1")) {
        return Response.json([
          {
            id: "mi-1",
            displayName: "Foundry assistant",
            subtype: "AI Agent",
            risk: { severity: "low" },
          },
        ]);
      }
      return new Response("missing", { status: 404 });
    };

    const agents = await listTenantAgents(config(), fetchImpl);
    const listCall = calls.find((call) => call.url.includes("/machine-identities/v1"));
    assert.equal(agents[0]?.id, "mi-1");
    assert.equal(agents[0]?.name, "Foundry assistant");
    assert.equal(agents[0]?.riskLevel, "Low");
    assert.equal(listCall?.experimental, "true");
    assert.equal(listCall?.url.includes("/machine-identities/v1?limit=250&offset=0"), true);
  });

  it("falls back to the yearly machine identity API", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("/machine-identities/v1")) {
        return new Response("missing", { status: 404 });
      }
      if (String(url).includes("/v2026/machine-identities")) {
        return Response.json([{ id: "mi-old", businessApplication: "Legacy agent" }]);
      }
      return new Response("missing", { status: 404 });
    };

    const agents = await listTenantAgents(config(), fetchImpl);
    assert.equal(agents[0]?.name, "Legacy agent");
  });

  it("stores the agent risk when the severity path is rejected", async () => {
    const patches: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      patches.push(String(init?.body ?? ""));
      if (String(init?.body ?? "").includes("/risk/severity")) {
        return new Response("not patchable", { status: 400 });
      }
      return Response.json({ id: "mi-1" });
    };

    const message = await updateTenantAgentRisk("mi-1", "high", config(), fetchImpl);
    assert.match(message, /stored HIGH/);
    assert.equal(patches.some((body) => body.includes("/attributes/riskLevel")), true);
  });
});
