import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENTFORGE_PATHS,
  checkIscConnection,
  summarizeConnectionCheck,
} from "@/lib/isc/connection-check";

const INPUT = {
  tenant: "beta-26912",
  domain: "identitynow-demo.com",
  clientId: "client-id",
  clientSecret: "super-secret-value",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MAINTENANCE_PAGE = "<!DOCTYPE html><html><head><title>Maintenance</title></head></html>";

function healthyFetch(sources: Array<{ name: string }> = [{ name: "TestDriveUsers" }, { name: "IdentityNow" }]) {
  return async (url: string) => {
    if (url.endsWith("/oauth/token")) return json({ access_token: "token-value" });
    if (url.includes("/v3/sources")) return json(sources);
    return json([]);
  };
}

describe("checkIscConnection", () => {
  it("passes when the client is accepted and every AgentForge path answers with JSON", async () => {
    const check = await checkIscConnection(INPUT, healthyFetch());
    assert.equal(check.ok, true);
    assert.equal(check.host, "https://beta-26912.api.identitynow-demo.com");
    const pathSteps = check.steps.filter((step) => step.id.startsWith("path:"));
    assert.equal(pathSteps.length, AGENTFORGE_PATHS.length);
  });

  it("never includes the secret or the token in the result", async () => {
    const check = await checkIscConnection(INPUT, healthyFetch());
    const text = JSON.stringify(check);
    assert.equal(text.includes("super-secret-value"), false);
    assert.equal(text.includes("token-value"), false);
  });

  it("reports a redirect to a maintenance host as a failure, not a page", async () => {
    const redirecting = async () =>
      new Response("", { status: 301, headers: { location: "https://maintenance.identitynow-demo.com/" } });
    const check = await checkIscConnection(INPUT, redirecting);
    assert.equal(check.ok, false);
    assert.equal(check.steps[0]?.id, "token");
    assert.match(check.steps[0]?.detail ?? "", /Redirected to https:\/\/maintenance/);
  });

  it("reports a web page returned in place of a token", async () => {
    const page = async () => new Response(MAINTENANCE_PAGE, { status: 200, headers: { "Content-Type": "text/html" } });
    const check = await checkIscConnection(INPUT, page);
    assert.equal(check.ok, false);
    assert.match(check.steps[0]?.detail ?? "", /web page \(Maintenance\)/);
  });

  it("explains a Cloudflare block page on the AgentForge paths while the token and /v3 work", async () => {
    const cloudflare =
      "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>";
    const blocked = async (url: string) => {
      if (url.endsWith("/oauth/token")) return json({ access_token: "token-value" });
      if (url.includes("/v3/sources")) return json([{ name: "TestDriveUsers" }, { name: "IdentityNow" }]);
      return new Response(cloudflare, { status: 403, headers: { "Content-Type": "text/html" } });
    };
    const check = await checkIscConnection(INPUT, blocked);
    assert.equal(check.ok, false);
    assert.equal(check.steps.find((step) => step.id === "token")?.ok, true);
    const first = check.steps.find((step) => step.id.startsWith("path:"));
    assert.match(first?.detail ?? "", /Cloudflare answered with a block page/);
    assert.match(first?.detail ?? "", /client is accepted/);
  });

  it("reports a rejected client ID or secret", async () => {
    const rejected = async () => json({ error: "invalid_client" }, 401);
    const check = await checkIscConnection(INPUT, rejected);
    assert.equal(check.ok, false);
    assert.match(check.steps[0]?.detail ?? "", /HTTP 401/);
  });

  it("reports a missing Test Drive source without failing the check", async () => {
    const check = await checkIscConnection(INPUT, healthyFetch([{ name: "IdentityNow" }]));
    const missing = check.steps.find((step) => step.id === "source:TestDriveUsers");
    assert.equal(missing?.ok, false);
    assert.equal(missing?.required, false);
    assert.equal(check.ok, true);
  });

  it("fails when an AgentForge path answers with a web page", async () => {
    const fetchImpl = async (url: string) => {
      if (url.endsWith("/oauth/token")) return json({ access_token: "token-value" });
      if (url.includes("/v3/sources")) return json([{ name: "IdentityNow" }]);
      if (url.includes("/roles/v1")) return new Response(MAINTENANCE_PAGE, { status: 200 });
      return json([]);
    };
    const check = await checkIscConnection(INPUT, fetchImpl);
    assert.equal(check.ok, false);
    const failed = check.steps.find((step) => step.id === "path:/roles/v1?limit=1");
    assert.equal(failed?.ok, false);
    assert.match(failed?.detail ?? "", /Web page "Maintenance"/);
  });

  it("asks for all three inputs before calling anything", async () => {
    let called = false;
    const check = await checkIscConnection(
      { ...INPUT, clientSecret: "" },
      async () => {
        called = true;
        return json({});
      },
    );
    assert.equal(called, false);
    assert.equal(check.ok, false);
  });

  it("summarizes the first failed required step", async () => {
    const check = await checkIscConnection(INPUT, async () => json({ error: "nope" }, 500));
    assert.match(summarizeConnectionCheck(check), /1 check\(s\) failed/);
    assert.match(summarizeConnectionCheck(check), /Token/);
  });
});
