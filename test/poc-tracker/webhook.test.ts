import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { receivePocTrackerWebhook } from "@/lib/poc-tracker/webhook";
import { POC_TRACKER_WEBHOOK_PATH } from "@/lib/poc-tracker/store";
import {
  memoryWebhookStore,
  registerProjectWebhook,
  TEST_DRIVE_WEBHOOK_PATH,
} from "@/lib/readonly-account/asana-webhook";

const TASK = "1234567890123";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("SAF POC Tracker webhook", () => {
  it("stores the handshake and echoes it", async () => {
    const store = memoryWebhookStore();
    let stashed = "";
    const notes: string[] = [];
    const result = await receivePocTrackerWebhook(
      { hookSecret: "handshake-secret", signature: null, body: "", stashGid: "stash-1" },
      {
        store,
        writeSecret: async (_stashGid, secret) => {
          stashed = secret;
        },
        record: async (message) => {
          notes.push(message);
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers["X-Hook-Secret"], "handshake-secret");
    assert.equal(stashed, "handshake-secret");
    assert.deepEqual(result.taskGids, []);
    assert.deepEqual(notes, ["Handshake completed."]);
  });

  it("rejects a bad signature and does not name a task", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: "",
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const notes: string[] = [];
    const body = JSON.stringify({
      events: [{ action: "changed", resource: { gid: TASK, resource_type: "task" } }],
    });
    const result = await receivePocTrackerWebhook(
      { hookSecret: null, signature: "deadbeef", body },
      {
        store,
        record: async (message) => {
          notes.push(message);
        },
      },
    );
    assert.equal(result.status, 401);
    assert.deepEqual(result.taskGids, []);
    assert.match(notes.join("\n"), /signature did not match/);
  });

  it("records a heartbeat and returns changed tasks from a signed delivery", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: "",
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const notes: string[] = [];
    const heartbeat = await receivePocTrackerWebhook(
      { hookSecret: null, signature: sign("{}", "handshake-secret"), body: "{}" },
      {
        store,
        record: async (message) => {
          notes.push(message);
        },
      },
    );
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(heartbeat.taskGids, []);
    const body = JSON.stringify({
      events: [
        { action: "changed", resource: { gid: TASK, resource_type: "task" } },
        { action: "added", resource: { gid: "1234567890126", resource_type: "story" } },
      ],
    });
    const delivery = await receivePocTrackerWebhook(
      { hookSecret: null, signature: sign(body, "handshake-secret"), body },
      {
        store,
        record: async (message) => {
          notes.push(message);
        },
      },
    );
    assert.equal(delivery.status, 200);
    assert.deepEqual(delivery.taskGids, [TASK]);
    assert.match(notes.join("\n"), /Heartbeat received/);
    assert.match(notes.join("\n"), new RegExp(TASK));
  });

  it("replaces the POC Tracker webhook and leaves the TestDrive webhook in place", async () => {
    const store = memoryWebhookStore();
    const deleted: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url);
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        deleted.push(new URL(target).pathname);
        return Response.json({ data: {} });
      }
      if (target.includes("/tasks/stash-poc")) {
        return Response.json({ data: { gid: "stash-poc", notes: "handshake-secret" } });
      }
      if (method === "POST" && target.endsWith("/webhooks")) {
        return Response.json({ data: { gid: "hook-poc" } });
      }
      if (target.includes("/projects/proj-poc")) {
        return Response.json({
          data: { gid: "proj-poc", name: "POC Gateway - Request Management", workspace: { gid: "ws-1" } },
        });
      }
      if (target.includes("/webhooks?")) {
        return Response.json({
          data: [
            { gid: "hook-testdrive", target: `https://example.test${TEST_DRIVE_WEBHOOK_PATH}?stash=old` },
            { gid: "hook-poc-old", target: `https://example.test${POC_TRACKER_WEBHOOK_PATH}?stash=stash-poc` },
          ],
        });
      }
      return new Response(`unexpected ${method} ${target}`, { status: 500 });
    };

    const result = await registerProjectWebhook({
      token: "asana-token",
      projectName: "POC Gateway - Request Management",
      projectGid: "proj-poc",
      targetUrl: `https://example.test${POC_TRACKER_WEBHOOK_PATH}`,
      hookPath: POC_TRACKER_WEBHOOK_PATH,
      fetchImpl,
      store,
    });

    assert.equal(result.webhookGid, "hook-poc");
    assert.deepEqual(deleted, ["/api/1.0/webhooks/hook-poc-old"]);
    assert.equal((await store.load())?.projectGid, "proj-poc");
    assert.equal((await store.load())?.secret, "handshake-secret");
  });
});
