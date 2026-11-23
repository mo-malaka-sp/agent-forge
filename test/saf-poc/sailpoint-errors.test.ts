import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSailPointClient, type SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";

const config: SailPointSetupConfig = {
  tenant: "beta-25503",
  apiBase: "https://beta-25503.api.identitynow-demo.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  ownerId: "",
  ownerName: "",
  triggerName: "CAEP Risk Level Change Events",
  notifyEmail: "",
};

const MAINTENANCE_PAGE = "<!DOCTYPE html>\n<html><head><title>Maintenance</title></head></html>";

function redirectedPage(url: string): Response {
  const response = new Response(MAINTENANCE_PAGE, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
  Object.defineProperty(response, "redirected", { value: true });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("SailPoint client errors", () => {
  it("names the redirect when a retired tenant sends the token call to a maintenance page", async () => {
    const client = createSailPointClient(config, async () =>
      redirectedPage("https://maintenance.identitynow-demo.com/"),
    );
    await assert.rejects(
      client.authorize(),
      /POST \/oauth\/token on https:\/\/beta-25503\.api\.identitynow-demo\.com was redirected to https:\/\/maintenance\.identitynow-demo\.com\//,
    );
  });

  it("names the redirect for an API call", async () => {
    const client = createSailPointClient(config, async (url) =>
      String(url).endsWith("/oauth/token")
        ? Response.json({ access_token: "header.e30.signature" })
        : redirectedPage("https://maintenance.identitynow-demo.com/"),
    );
    await assert.rejects(client.request("GET", "/sources/v1?limit=1"), /GET \/sources\/v1 on .* was redirected/);
  });

  it("reports a web page instead of a JSON parser error", async () => {
    const client = createSailPointClient(config, async (url) =>
      String(url).endsWith("/oauth/token")
        ? Response.json({ access_token: "header.e30.signature" })
        : new Response(MAINTENANCE_PAGE, { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    await assert.rejects(
      client.request("GET", "/roles/v1"),
      /GET \/roles\/v1 returned a web page instead of API data from https:\/\/beta-25503\.api\.identitynow-demo\.com/,
    );
  });
});
