import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
  asanaSignatureMatches,
  memoryWebhookStore,
  receiveAsanaWebhook,
  registerReadySectionWebhook,
  taskGidsMovedToSection,
} from "@/lib/readonly-account/asana-webhook";

const SECTION = "1200000000000002";
const TASK = "1234567890123";
const TARGET = "https://example.test/api/readonly-account/asana/webhook";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("Asana ready-section webhook", () => {
  it("keeps only tasks added to the ready section", () => {
    const gids = taskGidsMovedToSection(
      [
        {
          action: "added",
          resource: { gid: TASK, resource_type: "task" },
          parent: { gid: SECTION, resource_type: "section" },
        },
        {
          action: "added",
          resource: { gid: "9999999999999", resource_type: "task" },
          parent: { gid: "1200000000000009", resource_type: "section" },
        },
        {
          action: "removed",
          resource: { gid: TASK, resource_type: "task" },
          parent: { gid: SECTION, resource_type: "section" },
        },
      ],
      SECTION,
    );
    assert.deepEqual(gids, [TASK]);
  });

  it("stores the handshake secret and echoes it", async () => {
    const store = memoryWebhookStore();
    let stashed = "";
    const result = await receiveAsanaWebhook(
      { hookSecret: "handshake-secret", signature: null, body: "", stashGid: "stash-1", sectionGid: SECTION },
      {
        store,
        writeSecret: async (_stashGid, secret) => {
          stashed = secret;
        },
      },
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers["X-Hook-Secret"], "handshake-secret");
    assert.equal(stashed, "handshake-secret");
    assert.equal((await store.load())?.secret, "handshake-secret");
  });

  it("starts account creation for a signed move into the ready section", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: SECTION,
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const body = JSON.stringify({
      events: [
        {
          action: "added",
          resource: { gid: TASK, resource_type: "task" },
          parent: { gid: SECTION, resource_type: "section" },
        },
      ],
    });
    const accepted: string[] = [];
    const result = await receiveAsanaWebhook(
      { hookSecret: null, signature: sign(body, "handshake-secret"), body },
      { store, accept: async (taskGid) => accepted.push(taskGid) },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(accepted, [TASK]);
    assert.equal(asanaSignatureMatches(body, "handshake-secret", "nope"), false);
  });

  it("reads the handshake secret from Asana when this server does not have it", async () => {
    const store = memoryWebhookStore({
      secret: "",
      sectionGid: "",
      projectGid: "",
      webhookGid: "",
    });
    const body = JSON.stringify({
      events: [
        {
          action: "added",
          resource: { gid: TASK, resource_type: "task" },
          parent: { gid: SECTION, resource_type: "section" },
        },
      ],
    });
    const accepted: string[] = [];
    const result = await receiveAsanaWebhook(
      {
        hookSecret: null,
        signature: sign(body, "handshake-secret"),
        body,
        sectionGid: SECTION,
        stashGid: "stash-1",
      },
      {
        store,
        accept: async (taskGid) => accepted.push(taskGid),
        readSecret: async () => "handshake-secret",
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(accepted, [TASK]);
  });

  it("checks the task section when the move is not an added event", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: SECTION,
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const body = JSON.stringify({
      events: [
        {
          action: "changed",
          resource: { gid: TASK, resource_type: "task" },
        },
      ],
    });
    const accepted: string[] = [];
    const result = await receiveAsanaWebhook(
      { hookSecret: null, signature: sign(body, "handshake-secret"), body, sectionGid: SECTION },
      {
        store,
        accept: async (taskGid) => accepted.push(taskGid),
        confirmSection: async () => true,
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(accepted, [TASK]);
  });

  it("writes the failure on the task when the email already belongs to an identity", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: SECTION,
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const body = JSON.stringify({
      events: [
        {
          action: "added",
          resource: { gid: TASK, resource_type: "task" },
          parent: { gid: SECTION, resource_type: "section" },
        },
      ],
    });
    const failures: string[] = [];
    const result = await receiveAsanaWebhook(
      { hookSecret: null, signature: sign(body, "handshake-secret"), body, sectionGid: SECTION },
      {
        store,
        accept: async () => {
          throw new Error("This email already has an identity.");
        },
        reportFailure: async (_taskGid, message) => {
          failures.push(message);
        },
      },
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body?.accepted, []);
    assert.deepEqual(failures, ["This email already has an identity."]);
  });

  it("rejects a bad signature before creating an account", async () => {
    const store = memoryWebhookStore({
      secret: "handshake-secret",
      sectionGid: SECTION,
      projectGid: "1200000000000001",
      webhookGid: "1200000000000099",
    });
    const accepted: string[] = [];
    const result = await receiveAsanaWebhook(
      { hookSecret: null, signature: "deadbeef", body: JSON.stringify({ events: [] }) },
      { store, accept: async (taskGid) => accepted.push(taskGid) },
    );
    assert.equal(result.status, 401);
    assert.deepEqual(accepted, []);
  });

  it("registers a webhook on Ready for TES and keeps the handshake secret", async () => {
    const store = memoryWebhookStore();
    const calls: string[] = [];
    let notes = "pending";
    const fetchImpl: typeof fetch = async (url, init) => {
      const target = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${new URL(target).pathname}`);
      if (method === "POST" && new URL(target).pathname.endsWith("/tasks")) {
        return Response.json({ data: { gid: "stash-1" } });
      }
      if (target.includes("/tasks/stash-1")) {
        if (method === "PUT") {
          notes = JSON.parse(String(init?.body)).data.notes;
          return Response.json({ data: { gid: "stash-1", notes } });
        }
        return Response.json({ data: { gid: "stash-1", notes } });
      }
      if (method === "POST" && target.endsWith("/webhooks")) {
        notes = "handshake-secret";
        return Response.json({ data: { gid: "1200000000000099" } });
      }
      if (method === "DELETE") {
        return Response.json({ data: {} });
      }
      if (target.includes("/workspaces?") || target.endsWith("/workspaces")) {
        return Response.json({ data: [{ gid: "ws-1", name: "SailPoint" }] });
      }
      if (target.includes("/projects?")) {
        return Response.json({
          data: [{ gid: "proj-1", name: "POC Gateway - Request Management", archived: false }],
        });
      }
      if (target.includes("/projects/proj-1?")) {
        return Response.json({ data: { gid: "proj-1", name: "POC Gateway - Request Management", workspace: { gid: "ws-1" } } });
      }
      if (target.includes("/sections")) {
        return Response.json({ data: [{ gid: SECTION, name: "Ready for TES" }] });
      }
      if (target.includes("/webhooks?")) {
        return Response.json({
          data: [{ gid: "old-hook", target: TARGET }],
        });
      }
      return new Response(`unexpected ${method} ${target}`, { status: 500 });
    };

    const result = await registerReadySectionWebhook({
      token: "asana-token",
      targetUrl: TARGET,
      fetchImpl,
      store,
    });

    assert.equal(result.sectionGid, SECTION);
    assert.equal(result.webhookGid, "1200000000000099");
    assert.equal(new URL(result.targetUrl).searchParams.get("stash"), "stash-1");
    assert.equal((await store.load())?.secret, "handshake-secret");
    assert.ok(calls.includes("DELETE /api/1.0/webhooks/old-hook"));
    const create = calls.filter((call) => call === "POST /api/1.0/webhooks");
    assert.equal(create.length, 1);
  });
});
