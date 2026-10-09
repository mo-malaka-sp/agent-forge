import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";
import {
  listTenantAgents,
  parseAgentFindings,
  parseTenantAgents,
  readAgentRiskSnapshot,
  resolveAgentOwnerEmail,
  selectTenantAgents,
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

  it("does not call the deprecated yearly machine identity API", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      return new Response("missing", { status: 404 });
    };

    await assert.rejects(() => listTenantAgents(config(), fetchImpl));
    assert.equal(calls.some((url) => url.includes("/v2026/")), false);
  });

  it("looks up the owner email when the identity name is not an address", async () => {
    const [agent] = parseTenantAgents([
      {
        id: "mi-1",
        name: "POLICY_CONCIERGE",
        subtype: "AI Agent",
        owners: { primaryIdentity: { id: "owner-1", name: "mo.malaka", email: "mo.malaka" } },
      },
    ]);
    assert.equal(agent?.ownerEmail, "");
    assert.equal(agent?.ownerName, "mo.malaka");

    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (String(url).includes("/identities/v1/owner-1")) {
        return Response.json({
          id: "owner-1",
          alias: "mo.malaka",
          attributes: { email: "mo.malaka@sailpoint.com" },
        });
      }
      return new Response("missing", { status: 404 });
    };

    assert.equal(await resolveAgentOwnerEmail(agent!, config(), fetchImpl), "mo.malaka@sailpoint.com");
  });

  it("reads the calculated severity and findings", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (target.endsWith("/machine-identities/v1/mi-1")) {
        return Response.json({
          id: "mi-1",
          displayName: "POLICY_CONCIERGE",
          subtype: "AI Agent",
          risk: { severity: "LOW" },
        });
      }
      if (target.endsWith("/anomalies")) {
        assert.equal(new Headers(init?.headers).get("X-SailPoint-Experimental"), "true");
        return Response.json({
          items: [
            {
              title: "No human owner confirmed",
              detectedAt: "2026-10-08T17:21:00.000Z",
            },
          ],
        });
      }
      return new Response("missing", { status: 404 });
    };

    const snapshot = await readAgentRiskSnapshot("mi-1", config(), fetchImpl);
    assert.equal(snapshot.calculatedSeverity, "Low");
    assert.equal(snapshot.findings[0]?.title, "No human owner confirmed");
    assert.equal(snapshot.findings[0]?.detectedAt, "2026-10-08T17:21:00.000Z");
    assert.equal(
      parseAgentFindings([
        { title: "No human owner confirmed", detectedAt: "2026-10-08T17:21:00.000Z" },
      ])[0]?.title,
      "No human owner confirmed",
    );
    assert.equal(calls.some((url) => url.endsWith("/machine-identities/v1/mi-1/anomalies")), true);
  });

  it("keeps the calculated severity when findings are unavailable", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (target.endsWith("/machine-identities/v1/mi-1")) {
        return Response.json({
          id: "mi-1",
          displayName: "POLICY_CONCIERGE",
          subtype: "AI Agent",
          risk: { severity: "LOW" },
        });
      }
      return new Response("missing", { status: 404 });
    };

    const snapshot = await readAgentRiskSnapshot("mi-1", config(), fetchImpl);
    assert.equal(snapshot.calculatedSeverity, "Low");
    assert.deepEqual(snapshot.findings, []);
    assert.match(snapshot.findingsNote, /did not return the anomalies list/i);
  });

  it("reads findings stored on the machine identity when the anomalies list is empty", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/oauth/token")) {
        return Response.json({ access_token: "token" });
      }
      if (target.endsWith("/machine-identities/v1/mi-1")) {
        return Response.json({
          id: "mi-1",
          displayName: "POLICY_CONCIERGE",
          subtype: "AI Agent",
          risk: { severity: "MEDIUM" },
          insights: [
            {
              type: "NO_HUMAN_OWNER",
              description: "No attributed owner means weak accountability.",
              detectedAt: "2026-10-08T17:21:00.000Z",
            },
          ],
        });
      }
      if (target.endsWith("/anomalies")) {
        return Response.json({ count: 0 });
      }
      return new Response("missing", { status: 404 });
    };

    const snapshot = await readAgentRiskSnapshot("mi-1", config(), fetchImpl);
    assert.equal(snapshot.calculatedSeverity, "Medium");
    assert.equal(snapshot.findings[0]?.title, "No Human Owner");
    assert.equal(snapshot.findings[0]?.detectedAt, "2026-10-08T17:21:00.000Z");
  });

});
