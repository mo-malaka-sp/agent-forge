import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { asanaDeskPublic, defaultAsanaDesk, saveAsanaDesk, tenantLink } from "@/lib/readonly-account/asana-desk";
import {
  acceptAsanaTask,
  fieldByName,
  finishPendingAsanaAccounts,
  leadSeFromAsanaTask,
  statusField,
  tickAsanaAccounts,
  type AsanaAccountJob,
  type AsanaCustomField,
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
    if (body && typeof body === "object" && "__httpStatus" in body) {
      const status = Number((body as { __httpStatus: number }).__httpStatus);
      return new Response(JSON.stringify(body), { status });
    }
    return body === null ? new Response(null, { status: 204 }) : Response.json(body);
  };
  return { client: createSailPointClient(config(), fetchImpl), calls };
}

const WAITING_ACCOUNT = {
  'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "luis.stone"': () => [
    {
      id: "acct-1",
      nativeIdentity: "luis.stone",
      identityId: "ident-1",
      attributes: { id: "luis.stone", location: `SAF Test Drive asana:${TASK_GID}` },
    },
  ],
};

function waitingJob(): AsanaAccountJob {
  return {
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
  };
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

const LEAD_TASK = {
  name: "State Farm Mutual - Upgrade to Agentic Biz +",
  custom_fields: [
    {
      name: "Lead SE",
      type: "people",
      people_value: [{ gid: "user-matt", name: "Matt Brands", email: "matt.brands@sailpoint.com" }],
    },
  ],
};

const FIELD_SETTINGS = [
  {
    custom_field: {
      gid: "field-status",
      name: "Request status",
      resource_subtype: "enum",
      enum_options: [
        { gid: "opt-new", name: "New request" },
        { gid: "opt-eval", name: "Evaluation" },
        { gid: "opt-approved", name: "Approved" },
        { gid: "opt-other", name: "Needs information" },
      ],
    },
  },
  { custom_field: { gid: "field-account", name: "Sandbox account", resource_subtype: "text" } },
  { custom_field: { gid: "field-code", name: "Initial password", resource_subtype: "text" } },
  { custom_field: { gid: "field-link", name: "Tenant link", resource_subtype: "text" } },
  { custom_field: { gid: "field-drive", name: "Test Drive Status", resource_subtype: "enum", enum_options: [{ gid: "opt-td", name: "New" }] } },
];

function testDesk() {
  return {
    ...defaultAsanaDesk(),
    tenant: "beta-25503",
    tenantLinkField: "Tenant link",
  };
}

function asanaFetch(
  stories: unknown[],
  options: {
    task?: Record<string, unknown>;
    users?: Record<string, { email?: string; name?: string }>;
    failMove?: boolean;
    failUpdate?: boolean;
    inAssigned?: boolean;
    sections?: Array<{ gid: string; name: string }>;
    moves?: unknown[];
    updates?: unknown[];
    urls?: string[];
  } = {},
) {
  const moves = options.moves ?? [];
  const updates = options.updates ?? [];
  const urls = options.urls ?? [];
  const sections = options.sections ?? [
    { gid: "section-ready", name: "Ready for TES" },
    { gid: "section-assigned", name: "Assigned" },
  ];
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    urls.push(target);
    const method = init?.method ?? "GET";
    if (target.includes("custom_field_settings")) {
      return Response.json({ data: FIELD_SETTINGS });
    }
    if (method === "PUT" && target.includes("/tasks/")) {
      if (options.failUpdate) {
        return new Response("no", { status: 500 });
      }
      updates.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { gid: TASK_GID } });
    }
    if (target.includes("/stories")) {
      if (method === "GET") {
        return Response.json({ data: [] });
      }
      stories.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { gid: "story-1" } });
    }
    if (target.includes("/addTask")) {
      if (options.failMove) {
        return new Response("no", { status: 500 });
      }
      moves.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { gid: "membership-1" } });
    }
    if (target.includes("/projects/") && target.includes("/sections")) {
      return Response.json({ data: sections });
    }
    if (target.includes("memberships.section")) {
      return Response.json({
        data: {
          memberships: options.inAssigned ? [{ section: { gid: "section-assigned" } }] : [],
        },
      });
    }
    if (target.includes("/users/")) {
      const gid = target.match(/\/users\/([^?]+)/)?.[1] ?? "";
      const user = options.users?.[gid];
      if (!user) {
        return new Response("missing user", { status: 404 });
      }
      return Response.json({ data: user });
    }
    return Response.json({ data: options.task ?? LEAD_TASK });
  };
  return fetchImpl;
}

const PASSWORD_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

const READY_ROUTES = {
  'GET /sources/v1?filters=name eq "TestDriveUsers"': () => [
    { id: "src-td", name: "TestDriveUsers", owner: { id: "owner-1", name: "Admin", type: "IDENTITY" } },
  ],
  "GET /identity-profiles/v1": () => [
    { id: "profile-1", name: "Test Drive", authoritativeSource: { id: "src-td" } },
  ],
  "GET /sources/v1/src-td/schemas": () => [
    {
      name: "account",
      identityAttribute: "e-mail",
      displayAttribute: "e-mail",
      attributes: ["givenName", "familyName", "e-mail", "type", "status"].map((name) => ({ name })),
    },
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
  "POST /v2025/generate-password-reset-token/digit": () => ({
    digitToken: "261856",
    requestId: "req-1",
  }),
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
  "POST /v2025/query-password-info": () => ({
    identityId: "ident-1",
    sourceId: "src-idn",
    publicKeyId: "key-1",
    publicKey: PASSWORD_KEY,
    accounts: [{ accountId: "maya.chen" }],
  }),
  "POST /v2025/set-password": () => ({}),
};

function rememberedAccounts() {
  const accounts: Record<string, unknown>[] = [];
  return {
    accounts,
    routes: {
      "GET /accounts/v1": (call: Call) => {
        const nativeIdentity = call.path.match(/nativeIdentity eq "([^"]+)"/)?.[1];
        if (nativeIdentity) {
          return accounts.filter((row) => row.nativeIdentity === nativeIdentity);
        }
        if (call.path.includes("identityId")) {
          return [];
        }
        return accounts;
      },
      "GET /identities/v1": (call: Call) => {
        const email = call.path.match(/email eq "([^"]+)"/)?.[1];
        const alias = call.path.match(/alias eq "([^"]+)"/)?.[1];
        return accounts
          .filter((row) => {
            const attributes = row.attributes as { "e-mail"?: string };
            return (
              (email && attributes["e-mail"] === email) ||
              (alias && row.nativeIdentity === alias)
            );
          })
          .map((row) => ({
            name: row.nativeIdentity,
            alias: row.nativeIdentity,
            email: (row.attributes as { "e-mail": string })["e-mail"],
          }));
      },
      "POST /accounts/v1": (call: Call) => {
        const attributes = (call.body as { attributes: Record<string, string> }).attributes;
        accounts.push({
          id: `acct-${accounts.length + 1}`,
          nativeIdentity: attributes["e-mail"] || attributes.id,
          identityId: "ident-1",
          attributes,
        });
        return { id: "task-create" };
      },
    },
  };
}

describe("Asana test-drive requests", () => {
  it("reads the Lead SE from the people field and ignores the task title", () => {
    const lead = leadSeFromAsanaTask({
      name: "State Farm Mutual - Upgrade to Agentic Biz +",
      custom_fields: [
        { name: "Lead SE Manager", type: "people", people_value: [{ name: "Devan D'Silva" }] },
        {
          name: "Lead SE",
          type: "people",
          people_value: [{ gid: "user-matt", name: "Matt Brands", email: "matt.brands@sailpoint.com" }],
        },
      ],
    });
    assert.deepEqual(lead, {
      gid: "user-matt",
      name: "Matt Brands",
      email: "matt.brands@sailpoint.com",
    });
    assert.throws(
      () => leadSeFromAsanaTask({ name: "State Farm Mutual", custom_fields: [] }),
      /The task needs a Lead SE\./,
    );
  });

  it("creates a testmail account, writes the fields, and sets Approved", async () => {
    const stories: unknown[] = [];
    const updates: unknown[] = [];
    const { accounts, routes } = rememberedAccounts();
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...routes });
    const store = memoryStore();
    const options = {
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories, { updates }) as typeof fetch,
      random: () => 0,
    };
    const first = await acceptAsanaTask(TASK_GID, options);
    assert.equal(first.userId, "maya.chen");
    assert.equal(first.email, "maya.chen@testmail.identitysoon.com");
    assert.equal(first.done, true);
    const created = calls.find((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.equal(
      (created?.body as { attributes: Record<string, string> }).attributes["e-mail"],
      "maya.chen@testmail.identitysoon.com",
    );
    assert.equal(calls.filter((call) => call.path.includes("email-test-mode")).length, 0);
    assert.deepEqual(updates[0], { data: { custom_fields: { "field-status": "opt-eval" } } });
    assert.deepEqual(
      (updates[1] as { data: { custom_fields: Record<string, string> } }).data.custom_fields,
      {
        "field-account": "maya.chen@testmail.identitysoon.com",
        "field-code": "261856",
        "field-link": "https://beta-25503.identitynow-demo.com",
        "field-status": "opt-approved",
      },
    );
    assert.equal(stories.length, 0);

    const second = await acceptAsanaTask(TASK_GID, options);
    assert.equal(second.userId, "maya.chen");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
    assert.equal(updates.length, 2);
    assert.equal(accounts.length, 1);
  });

  it("loads the Lead SE email from the Asana user when the task omits it", async () => {
    const stories: unknown[] = [];
    const { routes } = rememberedAccounts();
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch(stories, {
        task: {
          name: "State Farm Mutual - Upgrade to Agentic Biz +",
          custom_fields: [
            { name: "Lead SE", type: "people", people_value: [{ gid: "user-matt", name: "Matt Brands" }] },
          ],
        },
        users: { "user-matt": { name: "Matt Brands", email: "matt.brands@sailpoint.com" } },
      }) as typeof fetch,
    });
    assert.equal(status.email, "maya.chen@testmail.identitysoon.com");
    assert.equal(status.done, true);
  });

  it("creates an account when the task has no Lead SE", async () => {
    const { routes } = rememberedAccounts();
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...routes });
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch([], { task: { name: "State Farm Mutual", custom_fields: [] } }) as typeof fetch,
    });
    assert.equal(status.email, "maya.chen@testmail.identitysoon.com");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
  });

  it("gives the same Lead SE a second customer with a different name", async () => {
    const stories: unknown[] = [];
    const { routes } = rememberedAccounts();
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const options = {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories) as typeof fetch,
      random: () => 0,
    };
    const first = await acceptAsanaTask(TASK_GID, options);
    const second = await acceptAsanaTask("1234567890124", options);
    assert.equal(first.userId, "maya.chen");
    assert.equal(first.email, "maya.chen@testmail.identitysoon.com");
    assert.equal(second.userId, "maya.chen22");
    assert.equal(second.email, "maya.chen22@testmail.identitysoon.com");
  });

  it("finishes a waiting account when the tick runs", async () => {
    const stories: unknown[] = [];
    const { client } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const store = memoryStore([waitingJob()]);
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(status?.userId, "luis.stone");
    assert.equal(stories.length, 0);
  });

  it("leaves the task in Ready for TES until the invitation is sent", async () => {
    const stories: unknown[] = [];
    const moves: unknown[] = [];
    const { client } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "GET /identities/v1/ident-1/role-assignments": () => [],
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [],
    });
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore([waitingJob()]),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories, { moves }) as typeof fetch,
    });
    assert.equal(status?.done, false);
    assert.equal(moves.length, 0);
    assert.equal(stories.length, 0);
  });

  it("retries the Asana update without creating another account", async () => {
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const store = memoryStore([waitingJob()]);
    const first = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { failUpdate: true }) as typeof fetch,
    });
    assert.equal(first[0]?.done, false);
    assert.match(first[0]?.detail ?? "", /did not update the task/);

    const updates: unknown[] = [];
    const second = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { updates }) as typeof fetch,
    });
    assert.equal(second[0]?.done, true);
    assert.equal(updates.length, 1);
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 0);
  });

  it("skips the section move when the task is already in Assigned", async () => {
    const moves: unknown[] = [];
    const { client } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore([waitingJob()]),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { moves, inAssigned: true }) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(moves.length, 0);
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

  it("finishes an Asana account that already exists and sends the invitation", async () => {
    const stories: unknown[] = [];
    const { client, calls } = fakeTenant({
      ...READY_ROUTES,
      'GET /accounts/v1?filters=sourceId eq "src-td"': () => [
        {
          id: "acct-rosa",
          nativeIdentity: "rosa.stone",
          identityId: "ident-rosa",
          attributes: {
            givenName: "Rosa",
            familyName: "Stone",
            "e-mail": "mo.malaka+rosa@sailpoint.com",
            type: "TestDrive",
            status: "active",
            location: `SAF Test Drive asana:${TASK_GID}`,
          },
        },
      ],
      'GET /accounts/v1?filters=sourceId eq "src-td" and nativeIdentity eq "mo.malaka+rosa@sailpoint.com"':
        () => [
          {
            id: "acct-rosa",
            nativeIdentity: "mo.malaka+rosa@sailpoint.com",
            identityId: "ident-rosa",
            attributes: { "e-mail": "mo.malaka+rosa@sailpoint.com" },
          },
        ],
      "GET /identities/v1/ident-rosa": () => ({
        id: "ident-rosa",
        alias: "rosa.stone",
        lifecycleState: null,
      }),
      "POST /identities/v1/ident-rosa/set-lifecycle-state": () => ({}),
      'GET /accounts/v1?filters=identityId eq "ident-rosa" and sourceId eq "src-idn"': () => [
        { id: "idn-rosa", disabled: false },
      ],
      "GET /identities/v1/ident-rosa/role-assignments": () => [
        { id: "assign-rosa", role: { name: "ReadOnly-Admins" } },
      ],
    });
    const statuses = await finishPendingAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(statuses[0]?.done, true);
    assert.equal(statuses[0]?.userId, "rosa.stone");
    assert.match(statuses[0]?.detail ?? "", /Invitation sent to mo.malaka\+rosa@sailpoint.com/);
    assert.ok(calls.some((call) => call.method === "POST" && call.path.includes("set-lifecycle-state")));
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("creates the Lead SE only on TestDriveUsers and comments the password", async () => {
    const stories: unknown[] = [];
    const { routes } = rememberedAccounts();
    const { client, calls } = fakeTenant({
      ...READY_ROUTES,
      ...routes,
    });
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    const created = calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.equal(created.length, 1);
    const attributes = (created[0]?.body as { attributes: Record<string, string> }).attributes;
    assert.equal(attributes.sourceId, "src-td");
    assert.equal(attributes["e-mail"], "maya.chen@testmail.identitysoon.com");
    assert.equal(attributes.type, "TestDrive");
    assert.equal(attributes.status, "active");
    assert.equal(attributes.groups, undefined);
    assert.equal(status.done, true);
    assert.equal(stories.length, 0);
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("writes the reset code when set-password is forbidden and still invites", async () => {
    const updates: unknown[] = [];
    const { client, calls } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "POST /v2025/set-password": () => ({ __httpStatus: 403, message: "Forbidden" }),
    });
    const job = waitingJob();
    job.user.password = "TestDrive9!";
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore([job]),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { updates }) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.match(status?.detail ?? "", /HTTP 403/);
    const fields = (updates[0] as { data: { custom_fields: Record<string, string> } }).data.custom_fields;
    assert.equal(fields["field-code"], "261856");
    assert.equal(fields["field-account"], "luis.stone@example.com");
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("leaves the task in Evaluation when the reset code is refused", async () => {
    const updates: unknown[] = [];
    const { client, calls } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "POST /v2025/set-password": () => ({ __httpStatus: 403, message: "Forbidden" }),
      "POST /v2025/generate-password-reset-token/digit": () => ({
        __httpStatus: 403,
        message: "Digit token password reset is disabled.",
      }),
    });
    const job = waitingJob();
    job.user.password = "TestDrive9!";
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore([job]),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { updates }) as typeof fetch,
    });
    assert.equal(status?.done, false);
    assert.match(status?.detail ?? "", /Reset code was not issued/);
    assert.equal(updates.length, 0);
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("chooses the status field that contains New request, Evaluation, and Approved", () => {
    const fields = FIELD_SETTINGS.map((setting) => setting.custom_field) as AsanaCustomField[];
    assert.equal(statusField(fields, testDesk())?.gid, "field-status");
    assert.equal(fieldByName(fields, "Sandbox account")?.gid, "field-account");
  });

  it("hides the Asana token and SailPoint secret", () => {
    const file = `${process.cwd()}/data/asana-desk-test-${process.pid}.json`;
    const saved = saveAsanaDesk(
      { ...testDesk(), asanaToken: "asana-secret", clientSecret: "sail-secret" },
      file,
    );
    const view = asanaDeskPublic(saved);
    assert.equal(view.asanaTokenSet, true);
    assert.equal(view.clientSecretSet, true);
    assert.equal("asanaToken" in view, false);
    assert.equal("clientSecret" in view, false);
    assert.equal(tenantLink(saved), "https://beta-25503.identitynow-demo.com");
    fs.unlinkSync(file);
  });
});
