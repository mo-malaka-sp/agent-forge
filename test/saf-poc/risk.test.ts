import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { changeAgentRisk } from "@/lib/saf-poc/risk";

function accessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ identity_id: "idn-admin", user_name: "Admin User" })}.sig`;
}

function agentRecord(ownerEmail: string) {
  return {
    id: "agent-1",
    name: "POLICY_CONCIERGE",
    subtype: "AI Agent",
    owners: ownerEmail
      ? { primaryIdentity: { id: "owner-1", name: "mo.malaka", email: ownerEmail } }
      : {},
  };
}

describe("agent risk changes", () => {
  it("rejects a real agent condition before sending CAEP", async () => {
    await assert.rejects(
      () =>
        changeAgentRisk({
          mode: "agent-condition",
          agentId: "agent-1",
          riskLevel: "High",
          publicUrl: "https://example.test",
        }),
      /No event was sent/,
    );
  });

  it("uses the owner email and refuses an agent with no owner email", async () => {
    const previous = {
      SAF_TENANT: process.env.SAF_TENANT,
      SAF_API_BASE: process.env.SAF_API_BASE,
      SAF_CLIENT_ID: process.env.SAF_CLIENT_ID,
      SAF_CLIENT_SECRET: process.env.SAF_CLIENT_SECRET,
      SAF_NOTIFY_EMAIL: process.env.SAF_NOTIFY_EMAIL,
    };
    process.env.SAF_TENANT = "beta-25503";
    process.env.SAF_API_BASE = "https://beta-25503.api.identitynow-demo.com";
    process.env.SAF_CLIENT_ID = "client-id";
    process.env.SAF_CLIENT_SECRET = "client-secret";
    process.env.SAF_NOTIFY_EMAIL = "mo.malaka@sailpoint.com";
    const fetchFor = (ownerEmail: string): typeof fetch => async (url) => {
      const target = String(url);
      if (target.endsWith("/oauth/token")) {
        return Response.json({ access_token: accessToken() });
      }
      if (target.includes("/machine-identities/v1?")) {
        return Response.json([agentRecord(ownerEmail)]);
      }
      if (target.includes("/machine-identities/v1/agent-1/anomalies")) {
        return Response.json([]);
      }
      if (target.endsWith("/machine-identities/v1/agent-1")) {
        return Response.json(agentRecord(ownerEmail));
      }
      return new Response("unexpected", { status: 500 });
    };
    try {
      const sent = await changeAgentRisk({
        agentId: "agent-1",
        riskLevel: "High",
        identityEmail: "alan@example.com",
        publicUrl: "https://example.test",
        transmit: false,
        ingest: false,
        fetchImpl: fetchFor("mo.malaka@sailpoint.com"),
      });
      assert.equal(sent.identityEmail, "mo.malaka@sailpoint.com");
      assert.equal(sent.caep, null);

      await assert.rejects(
        () =>
          changeAgentRisk({
            agentId: "agent-1",
            riskLevel: "High",
            identityEmail: "alan@example.com",
            publicUrl: "https://example.test",
            transmit: false,
            ingest: false,
            fetchImpl: fetchFor(""),
          }),
        /This agent has no owner email, so SailPoint cannot correlate the event/,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
