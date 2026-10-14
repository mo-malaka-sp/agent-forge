import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { datadogApiBase, resetDatadogSecurityForTests } from "@/lib/saf-poc/datadog-security";
import {
  SAILPOINT_DEMO_DURATION_MS,
  countSailPointDemoTicks,
  sailPointDemoDelayMs,
} from "@/lib/saf-poc/demo-stream";
import {
  DETECTION_QUERY,
  buildFixture,
  buildSailPointDemoEvents,
  ingestSafEvent,
  listSafEvents,
  resetSafEvents,
  sailPointAgentUrl,
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
    assert.match(
      stored.normalized.sailpoint?.url ?? "",
      /^https:\/\/poc-tenant\..+\/ui\/a\/admin\/identities\/agent-af-42\/details\/attributes$/,
    );
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
      assert.match(created?.body ?? "", /"evaluationWindow":0/);
      assert.match(created?.body ?? "", /"keepAlive":0/);
      assert.match(created?.body ?? "", /"maxSignalDuration":0/);
      assert.match(created?.body ?? "", /Open affected agent in SailPoint/);
      assert.match(created?.body ?? "", /\{\{@sailpoint\.url\}\}/);
      const log = JSON.parse(posted?.body ?? "[]") as Array<{
        evt: { category: string };
        sailpoint?: { url: string };
      }>;
      assert.equal(log[0]?.evt.category, "security");
      assert.match(log[0]?.sailpoint?.url ?? "", /\/identities\/agent-af-42\/details\/attributes$/);
      assert.equal(
        datadogApiBase("https://http-intake.logs.us3.datadoghq.com/api/v2/logs"),
        "https://api.us3.datadoghq.com",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("builds tenant-aware ISC agent links and safely encodes the agent ID", () => {
    assert.equal(
      sailPointAgentUrl("Beta-25503", "agent/id with spaces", "identitynow-demo.com"),
      "https://beta-25503.identitynow-demo.com/ui/a/admin/identities/agent%2Fid%20with%20spaces/details/attributes",
    );
    assert.equal(sailPointAgentUrl("https://evil.example", "agent-1"), null);
    assert.equal(sailPointAgentUrl("beta-25503", "agent-1", "example..com"), null);
    assert.equal(sailPointAgentUrl("beta-25503", ""), null);
  });

  it("builds a SailPoint demo pack that the detection rule can match", () => {
    const events = buildSailPointDemoEvents();
    assert.equal(events.length, 8);
    const signalEvents = events.filter(
      (event) => event.risk.severity === "critical" || event.risk.severity === "high",
    );
    assert.ok(signalEvents.length >= 6);
    assert.ok(events.some((event) => event.eventType === "ExposedCredentialDetected"));
    for (const event of buildSailPointDemoEvents(40)) {
      incomingEventSchema.parse(event);
    }
  });

  it("spaces a 15-minute SailPoint demo into many more than 8 logs", () => {
    const slow = sequence(0.99);
    const fast = sequence(0);
    assert.equal(sailPointDemoDelayMs(sequence(0, 0)), 2_000);
    assert.equal(sailPointDemoDelayMs(sequence(0.99, 0)), 12_000);
    assert.ok(sailPointDemoDelayMs(slow) <= 22_000);
    const quietTicks = countSailPointDemoTicks(SAILPOINT_DEMO_DURATION_MS, () => 0.99);
    const burstTicks = countSailPointDemoTicks(SAILPOINT_DEMO_DURATION_MS, fast);
    assert.ok(quietTicks >= 30);
    assert.ok(burstTicks > quietTicks);
    assert.equal(SAILPOINT_DEMO_DURATION_MS, 15 * 60 * 1000);
  });

  it("treats an existing Security Inbox rule as ready", async () => {
    process.env.DD_API_KEY = "dd-test-key";
    process.env.DD_APP_KEY = "dd-app-key";
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const method = init?.method ?? "GET";
      if (String(url).includes("/security_monitoring/rules") && method === "POST") {
        return new Response(
          JSON.stringify({
            errors: [
              {
                code: "InvalidArgument",
                details: [{ code: "AlreadyExists", message: "Rule name must be unique", target: "name" }],
              },
            ],
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    try {
      const stored = await ingestSafEvent({
        payload: buildFixture("critical-escalation"),
        source: "simulator",
        scenario: "critical-escalation",
      });
      assert.match(stored.delivery.detail, /Security Inbox rule is ready/);
    } finally {
      globalThis.fetch = original;
    }
  });
});

function sequence(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}
