import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptAsanaTask,
  personFromAsanaTask,
  tickAsanaAccounts,
  type AsanaAccountJob,
} from "@/lib/readonly-account/asana";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";
import { createSailPointClient, type SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";

const TASK_GID = "1234567890123";

function config(): SailPointSetupConfig {
  return {
    tenant: "beta-25503",
    apiBase: "https://beta-25503.api.identitynow-demo.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "admin@example.com",
  };
}

type Call = { method: string; path: string; body: unknown };

function fakeTenant(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") {
      return Response.json({ access_token: "header.e30.signature" });
    }
    const method = init?.method ?? "GET";
    const filters = parsed.searchParams.get("filters");
    const path = `${parsed.pathname}${filters ? `?filters=${filters}` : ""}`;
    const call = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[`${method} ${path}`] ?? routes[`${method} ${parsed.pathname}`];
    if (!route) {
      return new Response(`unexpected ${method} ${path}`, { status: 500 });
    }
    const body = route(call);
    return body === null ? new Response(null, { status: 204 }) : Response.json(body);
  };
  return { client: createSailPointClient(config(), fetchImpl), calls };
}

function memoryStore(seed: AsanaAccountJob[] = []) {
  let jobs = seed;
  return {
    load: () => jobs,
    save: (next: AsanaAccountJob[]) => {
      jobs = next;
    },
  };
}

function asanaFetch(stories: unknown[]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? "GET";
    if (target.includes("/stories")) {
      if (method === "GET") {
        return Response.json({ data: [] });
      }
      stories.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { gid: "story-1" } });
    }
    return Response.json({
      data: {
        name: "Luis Stone",
        custom_fields: [{ name: "Email", display_value: "luis.stone@example.com" }],
      },
    });
  };
}

const READY_ROUTES = {
  'GET /sources/v1?filters=name eq "ISC Admins"': () => [
    { id: "src-admins", name: "ISC Admins", owner: { id: "owner-1", name: "Admin", type: "IDENTITY" } },
  ],
  "GET /identity-profiles/v1": () => [
    { id: "profile-1", name: "Admins", authoritativeSource: { id: "src-admins" } },
  ],
  "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [
    { id: "state-active", technicalName: "active", enabled: true },
  ],
  'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [
    { id: "role-1", name: "ReadOnly-Admins", enabled: true },
  ],
  'GET /entitlements/v1?filters=name eq "SAF Admin"': () => [
    { id: "ent-saf", name: "SAF Admin", source: { id: "src-idn", name: "IdentityNow" } },
  ],
  'GET /identities/v1?filters=email eq "luis.stone@example.com"': () => [],
  'GET /identities/v1?filters=alias eq "luis.stone"': () => [],
  "POST /identities/v1/process": () => ({ id: "task-process" }),
  "GET /identities/v1/ident-1": () => ({
    id: "ident-1",
    alias: "luis.stone",
    lifecycleState: { stateName: "active" },
  }),
  'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
    { id: "idn-1", disabled: false },
  ],
  "GET /identities/v1/ident-1/role-assignments": () => [
    { id: "assign-1", role: { name: "ReadOnly-Admins" } },
  ],
  "POST /beta/identities/invite": () => ({ id: "invite-task" }),
};

describe("Asana test-drive requests", () => {
  it("reads the requester name and email from the task", () => {
    const person = personFromAsanaTask({
      name: "Request",
      notes: "please use ada@example.com",
      custom_fields: [{ name: "Full name", display_value: "Ada Lovelace" }],
    });
    assert.deepEqual(person, {
      givenName: "ada",
      familyName: "lovelace",
      email: "ada@example.com",
    });
  });

  it("creates one firstname.lastname account and comments the username once", async () => {
    let account: Record<string, unknown> | null = null;
    const stories: unknown[] = [];
    const { client, calls } = fakeTenant({
      ...READY_ROUTES,
      'GET /accounts/v1?filters=sourceId eq "src-admins"': () => (account ? [account] : []),
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "luis.stone"': () =>
        account ? [account] : [],
      "POST /accounts/v1": (call) => {
        const attributes = (call.body as { attributes: Record<string, string> }).attributes;
        account = {
          id: "acct-1",
          nativeIdentity: attributes.id,
          identityId: "ident-1",
          attributes,
        };
        return { id: "task-create" };
      },
    });
    const store = memoryStore();
    const options = {
      token: "asana-token",
      client,
      store,
      fetchImpl: asanaFetch(stories) as typeof fetch,
      random: () => 0,
    };
    const first = await acceptAsanaTask(TASK_GID, options);
    assert.equal(first.userId, "luis.stone");
    assert.equal(first.email, "luis.stone@example.com");
    assert.equal(first.done, true);
    const created = calls.find((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.deepEqual((created?.body as { attributes: Record<string, string> }).attributes, {
      sourceId: "src-admins",
      id: "luis.stone",
      name: "luis.stone",
      givenName: "Luis",
      familyName: "Stone",
      "e-mail": "luis.stone@example.com",
      location: `SAF Test Drive asana:${TASK_GID}`,
      groups: "ReadOnly-Admins",
    });
    assert.equal(calls.filter((call) => call.path.includes("email-test-mode")).length, 0);

    const second = await acceptAsanaTask(TASK_GID, options);
    assert.equal(second.userId, "luis.stone");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
    assert.equal(stories.length, 1);
    assert.match(JSON.stringify(stories[0]), /Username: luis.stone/);
  });

  it("finishes a waiting account when the tick runs", async () => {
    const stories: unknown[] = [];
    const { client } = fakeTenant({
      ...READY_ROUTES,
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "luis.stone"': () => [
        {
          id: "acct-1",
          nativeIdentity: "luis.stone",
          identityId: "ident-1",
          attributes: { id: "luis.stone", location: `SAF Test Drive asana:${TASK_GID}` },
        },
      ],
    });
    const store = memoryStore([
      {
        asanaTaskGid: TASK_GID,
        user: {
          id: "luis.stone",
          name: "Luis Stone",
          givenName: "Luis",
          familyName: "Stone",
          email: "luis.stone@example.com",
          password: "",
        },
        refs: {
          sourceId: "src-admins",
          profileId: "profile-1",
          activeStateId: "state-active",
          identityNowSourceId: "src-idn",
        },
        sailPointTaskId: "task-create",
        processed: false,
        inviteSent: false,
        inviteError: null,
        attempt: 0,
        commented: false,
        detail: "Account requested.",
        createdAt: "2026-10-22T00:00:00.000Z",
      },
    ]);
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(status?.userId, "luis.stone");
    assert.equal(stories.length, 1);
  });

  it("rejects a caller that does not have the worker secret", () => {
    const previous = process.env.SAF_POC_WORKER_TOKEN;
    process.env.SAF_POC_WORKER_TOKEN = "worker-secret";
    try {
      assert.equal(workerAuthorized("worker-secret"), true);
      assert.equal(workerAuthorized("wrong"), false);
    } finally {
      if (previous === undefined) delete process.env.SAF_POC_WORKER_TOKEN;
      else process.env.SAF_POC_WORKER_TOKEN = previous;
    }
  });
});
