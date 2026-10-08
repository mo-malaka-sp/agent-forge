import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resetSafPocStoreForTests } from "@/lib/saf-poc/storage";
import {
  RISK_LEVEL_CHANGE_EVENT,
  configurationDocument,
  dispatchSsf,
  publishRiskLevelChange,
} from "@/lib/saf-poc/transmitter";

const directories: string[] = [];
const issuer = "https://transmitter.example";

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ssf-transmitter-"));
  directories.push(directory);
  process.env.AGENT_STORE_DIR = directory;
  process.env.SAF_POC_TABLE_NAME = "";
  process.env.SSF_API_TOKEN = "transmitter-token";
  process.env.SAF_NOTIFY_EMAIL = "mo.malaka@sailpoint.com";
  process.env.SAF_TENANT = "poc-tenant";
  resetSafPocStoreForTests();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CAEP transmitter", () => {
  it("publishes discovery metadata and requires the API token", async () => {
    const document = configurationDocument(issuer) as {
      issuer: string;
      jwks_uri: string;
      configuration_endpoint: string;
    };
    assert.equal(document.issuer, issuer);
    assert.equal(document.jwks_uri, `${issuer}/jwks`);
    assert.equal(document.configuration_endpoint, `${issuer}/ssf/stream`);

    const denied = await dispatchSsf({
      method: "POST",
      path: "stream",
      publicUrl: issuer,
      body: {},
    });
    assert.equal(denied.status, 401);
  });

  it("queues a risk-level change until SailPoint polls", async () => {
    const created = await dispatchSsf({
      method: "POST",
      path: "stream",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: {
        delivery: { method: "urn:ietf:rfc:8936" },
        events_requested: [RISK_LEVEL_CHANGE_EVENT],
      },
    });
    const stream = created.body as { delivery: { endpoint_url: string } };
    assert.equal(created.status, 201);
    assert.equal(stream.delivery.endpoint_url, `${issuer}/ssf/poll`);

    const emitted = await dispatchSsf({
      method: "POST",
      path: "risk-level-change",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: { previousLevel: "LOW", currentLevel: "HIGH" },
    });
    assert.equal(emitted.status, 202);

    const polled = await dispatchSsf({
      method: "POST",
      path: "poll",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: { maxEvents: 5, returnImmediately: true },
    });
    const page = polled.body as { sets: Record<string, string> };
    const tokenValue = Object.values(page.sets)[0] ?? "";
    const payload = await verifySet(tokenValue);
    const events = payload.events as Record<string, { current_level: string }>;
    const subject = payload.sub_id as { email: string };
    assert.equal(subject.email, "mo.malaka@sailpoint.com");
    assert.equal(events[RISK_LEVEL_CHANGE_EVENT]?.current_level, "HIGH");
  });

  it("pushes a signed risk-level change to the receiver endpoint", async () => {
    const pushed: Array<{ url: string; contentType: string | null; body: string }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      pushed.push({
        url: String(url),
        contentType: new Headers(init?.headers).get("content-type"),
        body: String(init?.body ?? ""),
      });
      return new Response("", { status: 202 });
    };
    const created = await dispatchSsf({
      method: "POST",
      path: "stream",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      fetchImpl,
      body: {
        delivery: {
          method: "https://schemas.openid.net/secevent/risc/delivery-method/push",
          endpoint_url: "https://receiver.example/events",
        },
      },
    });
    assert.equal(created.status, 201);

    const emitted = await publishRiskLevelChange({
      publicUrl: issuer,
      email: "mo.malaka@sailpoint.com",
      previousLevel: "LOW",
      currentLevel: "HIGH",
      fetchImpl,
    });
    assert.equal(emitted.deliveries[0]?.accepted, true);
    assert.equal(pushed[0]?.url, "https://receiver.example/events");
    assert.equal(pushed[0]?.contentType, "application/secevent+jwt");
    const payload = await verifySet(pushed[0]?.body ?? "");
    assert.equal((payload.sub_id as { email: string }).email, "mo.malaka@sailpoint.com");
  });

  it("holds an event for an email the receiver did not subscribe", async () => {
    await dispatchSsf({
      method: "POST",
      path: "stream",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: { delivery: { method: "urn:ietf:rfc:8936" } },
    });
    const added = await dispatchSsf({
      method: "POST",
      path: "subjects/add",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: { subject: { format: "email", email: "other@example.com" } },
    });
    assert.equal(added.status, 200);
    const emitted = await dispatchSsf({
      method: "POST",
      path: "risk-level-change",
      publicUrl: issuer,
      authorization: "Bearer transmitter-token",
      body: { email: "mo.malaka@sailpoint.com" },
    });
    const result = emitted.body as { deliveries: Array<{ accepted: boolean }> };
    assert.equal(result.deliveries[0]?.accepted, false);
  });
});

async function verifySet(token: string): Promise<Record<string, unknown>> {
  const directory = process.env.AGENT_STORE_DIR ?? "";
  const persisted = JSON.parse(
    await readFile(path.join(directory, "saf-poc-state.json"), "utf8"),
  ) as { "SSF#state": { value: { privateKeyPem: string } } };
  const [header, body, signature] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${body}`);
  verifier.end();
  const valid = verifier.verify(
    createPublicKey(persisted["SSF#state"].value.privateKeyPem),
    Buffer.from(signature ?? "", "base64url"),
  );
  assert.equal(valid, true);
  return JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}
