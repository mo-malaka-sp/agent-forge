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
  pickSignalAgent,
  resetSafEvents,
  resetSignalAgentsForTests,
  sailPointAgentUrl,
  sailPointSignalHost,
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
  delete process.env.SAF_API_BASE;
  process.env.SAF_NOTIFY_EMAIL = "admin@example.com";
  process.env.DD_API_KEY = "";
  process.env.DD_APP_KEY = "";
  resetDatadogSecurityForTests();
  resetSafPocStoreForTests();
  resetSignalAgentsForTests();
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
      /^https:\/\/poc-tenant\..+\/ui\/agentic-overview\/agent-registry\/agent-af-42\/details\/risk$/,
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
      const listed = calls.find((call) => call.url.includes("/security_monitoring/rules?page"));
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
      assert.match(log[0]?.sailpoint?.url ?? "", /\/agent-registry\/agent-af-42\/details\/risk$/);
      assert.equal(
        datadogApiBase("https://http-intake.logs.us3.datadoghq.com/api/v2/logs"),
        "https://api.us3.datadoghq.com",
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("builds the agent risk link from the demo API host", () => {
    assert.equal(
      sailPointAgentUrl(
        "beta-25503",
        "edbbd8e8-3871-4246-a9a5-8ebc10bd1ab9",
        "identitynow-demo.com",
      ),
      "https://beta-25503.identitynow-demo.com/ui/agentic-overview/agent-registry/edbbd8e8-3871-4246-a9a5-8ebc10bd1ab9/details/risk",
    );
    assert.deepEqual(
      sailPointSignalHost({
        tenant: "beta-25503",
        domain: "identitynow.com",
        apiBase: "https://beta-25503.api.identitynow-demo.com",
      }),
      { tenant: "beta-25503", domain: "identitynow-demo.com" },
    );
    assert.equal(sailPointAgentUrl("https://evil.example", "agent-1"), null);
    assert.equal(sailPointAgentUrl("beta-25503", "agent-1", "example..com"), null);
    assert.equal(sailPointAgentUrl("beta-25503", ""), null);
  });

  it("links a generated signal to a randomly selected tenant agent", async () => {
    process.env.SAF_TENANT = "beta-25503";
    process.env.SAF_API_BASE = "https://beta-25503.api.identitynow-demo.com";
    process.env.SAF_CLIENT_ID = "client-id";
    process.env.SAF_CLIENT_SECRET = "client-secret";
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "x.e30.y" }), { status: 200 });
      }
      if (target.includes("/machine-identities/v1")) {
        return new Response(
          JSON.stringify([
            {
              id: "edbbd8e8-3871-4246-a9a5-8ebc10bd1ab9",
              name: "Registry agent",
              subtype: "AI Agent",
            },
          ]),
          { status: 200 },
        );
      }
      return new Response("unexpected", { status: 500 });
    };
    try {
      const first = pickSignalAgent(["one", "two"], () => 0.9);
      assert.equal(first, "two");
      const stored = await ingestSafEvent({
        payload: buildFixture("critical-escalation"),
        source: "simulator",
        scenario: "critical-escalation",
      });
      assert.equal(stored.event.agent.id, "edbbd8e8-3871-4246-a9a5-8ebc10bd1ab9");
      assert.equal(
        stored.normalized.sailpoint?.url,
        "https://beta-25503.identitynow-demo.com/ui/agentic-overview/agent-registry/edbbd8e8-3871-4246-a9a5-8ebc10bd1ab9/details/risk",
      );
    } finally {
      delete process.env.SAF_CLIENT_ID;
      delete process.env.SAF_CLIENT_SECRET;
      delete process.env.SAF_API_BASE;
      globalThis.fetch = original;
    }
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

  it("finds the SailPoint rule past the first page and updates its message", async () => {
    process.env.DD_API_KEY = "dd-test-key";
    process.env.DD_APP_KEY = "dd-app-key";
    const original = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      attributes: { name: `CloudTrail rule ${index}`, version: 1 },
    }));
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      const method = init?.method ?? "GET";
      calls.push({ url: target, method, body: String(init?.body ?? "") });
      if (target.includes("page[number]=0")) {
        return new Response(JSON.stringify({ data: filler }), { status: 200 });
      }
      if (target.includes("page[number]=1")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "q4-rg6-1rh",
                attributes: { name: "Critical Risk Detected by SailPoint Agentic Fabric", version: 3 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };
    try {
      await ingestSafEvent({
        payload: buildFixture("critical-escalation"),
        source: "simulator",
        scenario: "critical-escalation",
      });
      const updated = calls.find((call) => call.method === "PUT");
      assert.ok(updated?.url.endsWith("/security_monitoring/rules/q4-rg6-1rh"));
      assert.match(updated?.body ?? "", /Open affected agent in SailPoint/);
      assert.match(updated?.body ?? "", /"version":3/);
      assert.doesNotMatch(updated?.body ?? "", /"type":/);
      assert.equal(calls.some((call) => call.method === "POST" && call.url.includes("/rules")), false);
    } finally {
      globalThis.fetch = original;
    }
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
