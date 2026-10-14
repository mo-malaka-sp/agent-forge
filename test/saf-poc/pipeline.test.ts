import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { datadogApiBase, resetDatadogSecurityForTests } from "@/lib/saf-poc/datadog-security";
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
  process.env.DD_APP_KEY = "";
  resetDatadogSecurityForTests();
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
    assert.equal(stored.normalized.evt.category, "security");
    assert.equal(stored.normalized.evt.outcome, "critical");
    assert.equal(stored.normalized.usr.id, "idn-alex");
    assert.equal(stored.delivery.mode, "dry-run");
    assert.match(DETECTION_QUERY, /@evt\.outcome:critical/);
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
      assert.match(stored.delivery.detail, /DD_APP_KEY/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("creates a Security Inbox rule and posts security attributes", async () => {
    process.env.DD_API_KEY = "dd-test-key";
    process.env.DD_APP_KEY = "dd-app-key";
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body: string; appKey: string | null }> = [];
    globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
        appKey: headers.get("DD-APPLICATION-KEY"),
      });
      return new Response(JSON.stringify({ data: [] }), { status: 202 });
    };
    try {
      const stored = await ingestSafEvent({
        payload: buildFixture("critical-escalation"),
        source: "simulator",
        scenario: "critical-escalation",
      });
      assert.equal(stored.delivery.status, "delivered");
      assert.match(stored.delivery.detail, /Security Inbox rule is ready/);
      const listed = calls.find((call) => call.url.endsWith("/security_monitoring/rules"));
      const created = calls.find(
        (call) => call.url.endsWith("/security_monitoring/rules") && call.method === "POST",
      );
      const posted = calls.find((call) => call.url.includes("/api/v2/logs"));
      assert.equal(listed?.appKey, "dd-app-key");
      assert.match(created?.body ?? "", /@evt\.outcome:critical/);
      assert.match(created?.body ?? "", /@evt\.outcome:high/);
      assert.match(created?.body ?? "", /"maxSignalDuration":21600/);
      const log = JSON.parse(posted?.body ?? "[]") as Array<{ evt: { category: string } }>;
      assert.equal(log[0]?.evt.category, "security");
      assert.equal(
        datadogApiBase("https://http-intake.logs.us3.datadoghq.com/api/v2/logs"),
        "https://api.us3.datadoghq.com",
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
