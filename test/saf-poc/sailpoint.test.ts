import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { NOTIFICATION_SUBJECT } from "@/lib/saf-poc/events";
import {
  POC_WORKFLOW_NAME,
  setupTest1,
  type SailPointSetupConfig,
} from "@/lib/saf-poc/sailpoint";

function accessToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ identity_id: "idn-admin", user_name: "Admin User" })}.sig`;
}

function config(): SailPointSetupConfig {
  return {
    tenant: "acme-admin",
    apiBase: "https://acme-admin.api.identitynow.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "admin@example.com",
  };
}

describe("SailPoint Test 1 setup", () => {
  it("creates and enables the verification workflow for the configured trigger", async () => {
    const calls: Array<{ url: string; method: string; body: string; contentType: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        contentType: headers.get("Content-Type") ?? "",
      });
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: accessToken() });
      }
      if (String(url).includes("/workflow-library/v1/triggers")) {
        return Response.json([
          {
            id: "idn:caep-risk-level-change-events",
            name: "CAEP Risk Level Change Events",
            type: "EVENT",
          },
        ]);
      }
      if (String(url).includes("/workflows/v1?") && init?.method === "GET") {
        return Response.json([]);
      }
      if (String(url).endsWith("/workflows/v1") && init?.method === "POST") {
        return Response.json({ id: "wf-1", name: POC_WORKFLOW_NAME, enabled: false });
      }
      if (String(url).endsWith("/workflows/v1/wf-1") && init?.method === "PATCH") {
        return Response.json({ id: "wf-1", enabled: true });
      }
      return new Response("unexpected", { status: 500 });
    };

    const result = await setupTest1(config(), { fetchImpl });
    const createCall = calls.find(
      (call) => call.method === "POST" && call.url.endsWith("/workflows/v1"),
    );
    const created = JSON.parse(createCall?.body ?? "{}") as {
      name: string;
      definition: {
        steps: { "Send Email": { attributes: { subject: string } } };
      };
      trigger: { attributes: { id: string } };
    };
    const enableCall = calls.find((call) => call.method === "PATCH");

    assert.equal(result.workflowId, "wf-1");
    assert.equal(result.trigger.id, "idn:caep-risk-level-change-events");
    assert.equal(created.name, POC_WORKFLOW_NAME);
    assert.equal(
      created.definition.steps["Send Email"].attributes.subject,
      NOTIFICATION_SUBJECT,
    );
    assert.equal(created.trigger.attributes.id, "idn:caep-risk-level-change-events");
    assert.equal(enableCall?.contentType, "application/json-patch+json");
  });

  it("names the triggers on the tenant when the requested trigger is absent", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith("/oauth/token")) {
        return Response.json({ access_token: accessToken() });
      }
      if (String(url).includes("/triggers")) {
        return Response.json([{ id: "idn:other", name: "Other Trigger", type: "EVENT" }]);
      }
      return Response.json([]);
    };
    await assert.rejects(() => setupTest1(config(), { fetchImpl }), /Other Trigger/);
  });
});
