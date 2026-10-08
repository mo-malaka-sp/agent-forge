import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import {
  DETECTION_QUERY,
  buildFixture,
  ingestSafEvent,
  listSafEvents,
  resetSafEvents,
} from "@/lib/saf-poc/events";
import { resetSafPocStoreForTests } from "@/lib/saf-poc/storage";
import { incomingEventSchema } from "@/lib/saf-poc/types";

const directories: string[] = [];

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "saf-poc-"));
  directories.push(directory);
  process.env.AGENT_STORE_DIR = directory;
  process.env.SAF_POC_TABLE_NAME = "";
  process.env.SAF_TENANT = "poc-tenant";
  process.env.SAF_NOTIFY_EMAIL = "admin@example.com";
  process.env.DD_API_KEY = "";
  resetSafPocStoreForTests();
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SAF pipeline", () => {
  it("keeps an explicit API base and strips a trailing version", () => {
    process.env.SAF_TENANT = "beta-25503";
    process.env.SAF_API_BASE = "https://beta-25503.api.identitynow-demo.com/v3/";
    const config = loadSafPocConfig();
    assert.equal(config.tenant, "beta-25503");
    assert.equal(config.apiBase, "https://beta-25503.api.identitynow-demo.com");
  });

  it("rejects an exposed-credential event without a credential", () => {
    const example = buildFixture("exposed-credential");
    const { credential: _credential, ...withoutCredential } = example;
    assert.equal(incomingEventSchema.safeParse(withoutCredential).success, false);
  });

  it("records a critical event in dry-run and matches the detection query", async () => {
    const stored = await ingestSafEvent({
      payload: buildFixture("critical-escalation"),
      source: "simulator",
      scenario: "critical-escalation",
    });
    assert.equal(stored.normalized.ddsource, "sailpoint");
    assert.equal(stored.normalized.risk_severity, "critical");
    assert.equal(stored.delivery.mode, "dry-run");
    assert.match(DETECTION_QUERY, /@risk_severity:critical/);
    assert.equal((await listSafEvents()).length, 1);
    await resetSafEvents();
    assert.equal((await listSafEvents()).length, 0);
  });

  it("posts the Datadog intake with the DD-API-KEY header", async () => {
    process.env.DD_API_KEY = "dd-test-key";
    const original = globalThis.fetch;
    const calls: Array<RequestInit | undefined> = [];
    globalThis.fetch = async (_url, init) => {
      calls.push(init);
      return new Response("", { status: 202 });
    };
    try {
      const stored = await ingestSafEvent({
        payload: buildFixture("risk-state-changed"),
        source: "simulator",
        scenario: "risk-state-changed",
      });
      assert.equal(stored.delivery.status, "delivered");
      assert.equal(new Headers(calls[0]?.headers).get("DD-API-KEY"), "dd-test-key");
    } finally {
      globalThis.fetch = original;
    }
  });
});
