import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { asanaDeskPublic, defaultAsanaDesk, saveAsanaDesk, tenantLink } from "@/lib/readonly-account/asana-desk";
import {
  acceptAsanaTask,
  describeTaskStatus,
  fieldByName,
  finishPendingAsanaAccounts,
  leadSeFromAsanaTask,
  resumeAsanaTask,
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
        { gid: "opt-implemented", name: "Implemented" },
        { gid: "opt-declined", name: "Declined" },
        { gid: "opt-other", name: "Needs information" },
      ],
    },
  },
  { custom_field: { gid: "field-account", name: "Sandbox account", resource_subtype: "text" } },
  { custom_field: { gid: "field-code", name: "Initial password", resource_subtype: "text" } },
  { custom_field: { gid: "field-link", name: "Tenant link", resource_subtype: "text" } },
  {
    custom_field: {
      gid: "field-drive",
      name: "Test Drive Status",
      resource_subtype: "enum",
      enum_options: [
        { gid: "opt-td", name: "New" },
        { gid: "opt-done", name: "Done" },
      ],
    },
  },
];

function testDesk() {
  return {
    ...defaultAsanaDesk(),
    asanaToken: "asana-token",
    tenant: "beta-25503",
    clientId: "desk-client",
    clientSecret: "desk-secret",
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
    sectionName?: string;
    taskType?: string;
    accountEmail?: string;
    notes?: string;
    fields?: unknown[];
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
      return Response.json({ data: options.fields ?? FIELD_SETTINGS });
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
    if (target.includes("/projects/") && target.includes("/tasks?")) {
      return Response.json({ data: [] });
    }
    if (target.includes("/custom_types")) {
      return Response.json({
        data: [
          {
            gid: "type-1",
            status_options: [
              { gid: "s-new", name: "New request", enabled: true },
              { gid: "s-eval", name: "Evaluation", enabled: true },
              { gid: "s-implemented", name: "Implemented", enabled: true },
              { gid: "s-declined", name: "Declined", enabled: true },
              { gid: "s-approved", name: "Approved", enabled: true },
              { gid: "s-old", name: "Approved", enabled: false },
            ],
          },
        ],
      });
    }
    if (method === "GET" && options.taskType && target.includes(`/tasks/${TASK_GID}?`)) {
      return Response.json({
        data: {
          name: "SAF Test Drive Request - Customer004",
          custom_type: { gid: "type-1", name: "Work request" },
          custom_type_status_option: { gid: "s-current", name: options.taskType },
          custom_fields: options.accountEmail
            ? [{ gid: "field-account", display_value: options.accountEmail, text_value: options.accountEmail }]
            : [],
          notes: options.notes,
          memberships: [{ project: { gid: "project-1" }, section: { gid: "sec", name: "New Requests" } }],
        },
      });
    }
    if (target.includes("memberships.section")) {
      const section = options.inAssigned
        ? { gid: "section-assigned", name: options.sectionName ?? "Assigned" }
        : options.sectionName
          ? { gid: "section-new", name: options.sectionName }
          : null;
      return Response.json({
        data: {
          notes: options.notes,
          memberships: section ? [{ project: { gid: "project-1" }, section }] : [],
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
    const task = { ...(options.task ?? LEAD_TASK) };
    if (options.notes !== undefined) {
      task.notes = options.notes;
    }
    return Response.json({ data: task });
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
    assert.deepEqual(updates[0], {
      data: { custom_fields: { "field-account": "maya.chen@testmail.identitysoon.com" } },
    });
    assert.deepEqual(updates[1], { data: { custom_fields: { "field-status": "opt-eval" } } });
    assert.deepEqual(
      (updates[2] as { data: { custom_fields: Record<string, string> } }).data.custom_fields,
      {
        "field-account": "maya.chen@testmail.identitysoon.com",
        "field-code": "261856",
        "field-link": "https://beta-25503.identitynow-demo.com",
        "field-drive": "opt-done",
        "field-status": "opt-implemented",
      },
    );
    assert.equal(
      (updates[2] as { data: { notes?: string } }).data.notes,
      `--- FULFILLMENT DETAILS ---
TENANT_LINK: https://beta-25503.identitynow-demo.com
SANDBOX_ACCOUNT: maya.chen@testmail.identitysoon.com
INITIAL_PASSWORD: 261856
`,
    );
    assert.equal(stories.length, 0);

    const second = await acceptAsanaTask(TASK_GID, options);
    assert.equal(second.userId, "maya.chen");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
    assert.equal(updates.length, 3);
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

  it("declines the task when Asana rejects the update and does not create another account", async () => {
    const stories: unknown[] = [];
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const store = memoryStore([waitingJob()]);
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch(stories, { failUpdate: true }) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(status?.failed, true);
    assert.match(status?.detail ?? "", /did not update the task/);
    assert.match(JSON.stringify(stories[0]), /did not update the task/);
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
    assert.equal(fields["field-drive"], "opt-done");
    assert.equal(fields["field-status"], "opt-implemented");
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("declines the task and comments when the reset code is refused", async () => {
    const updates: unknown[] = [];
    const stories: unknown[] = [];
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
      fetchImpl: asanaFetch(stories, { updates }) as typeof fetch,
    });
    assert.equal(status?.failed, true);
    assert.match(status?.detail ?? "", /Reset code was not issued/);
    assert.match(JSON.stringify(stories[0]), /Reset code was not issued/);
    assert.deepEqual(updates.at(-1), { data: { custom_fields: { "field-status": "opt-declined" } } });
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("uses the board column when no custom field has New request, Evaluation, and Approved", async () => {
    const updates: unknown[] = [];
    const moves: unknown[] = [];
    const urls: string[] = [];
    const { routes } = rememberedAccounts();
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const columnFields = [
      {
        custom_field: {
          gid: "field-drive",
          name: "Test Drive Status",
          resource_subtype: "enum",
          enum_options: [
            { gid: "opt-td", name: "New" },
            { gid: "opt-done", name: "Done" },
          ],
        },
      },
      {
        custom_field: {
          gid: "field-extension",
          name: "New or extension",
          resource_subtype: "enum",
          enum_options: [
            { gid: "opt-nr", name: "New request" },
            { gid: "opt-ex", name: "Extension" },
          ],
        },
      },
      { custom_field: { gid: "field-account", name: "Sandbox account", resource_subtype: "text" } },
      { custom_field: { gid: "field-code", name: "Initial password", resource_subtype: "text" } },
      { custom_field: { gid: "field-link", name: "Tenant link", resource_subtype: "text" } },
    ];
    const fetchImpl = asanaFetch([], {
      updates,
      moves,
      urls,
      fields: columnFields,
      sections: [
        { gid: "section-new", name: "New request" },
        { gid: "section-eval", name: "Evaluation" },
        { gid: "section-approved", name: "Approved" },
        { gid: "section-implemented", name: "Implemented" },
        { gid: "section-declined", name: "Declined" },
      ],
    }) as typeof fetch;
    const seen = await describeTaskStatus(TASK_GID, {
      token: "asana-token",
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { fields: columnFields, sectionName: "New request" }) as typeof fetch,
    });
    assert.equal(seen, "New request");
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl,
    });
    assert.equal(status.done, true);
    assert.equal(status.email, "maya.chen@testmail.identitysoon.com");
    assert.ok(urls.some((url) => url.includes("/sections/section-eval/addTask")));
    assert.ok(urls.some((url) => url.includes("/sections/section-implemented/addTask")));
    assert.equal(moves.length, 2);
    const saved = updates.find((update) => {
      const fields = (update as { data?: { custom_fields?: Record<string, string> } }).data?.custom_fields;
      return Boolean(fields?.["field-code"]);
    }) as { data: { custom_fields: Record<string, string> } };
    assert.equal(saved.data.custom_fields["field-account"], "maya.chen@testmail.identitysoon.com");
    assert.equal(saved.data.custom_fields["field-code"], "261856");
    assert.equal(saved.data.custom_fields["field-status"], undefined);
  });

  it("reads and sets the task status when the task has a task type", async () => {
    const updates: unknown[] = [];
    const { routes } = rememberedAccounts();
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const seen = await describeTaskStatus(TASK_GID, {
      token: "asana-token",
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { taskType: "New request" }) as typeof fetch,
    });
    assert.equal(seen, "New request");
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch([], { taskType: "New request", updates }) as typeof fetch,
    });
    assert.equal(status.done, true);
    assert.deepEqual(updates[0], {
      data: { custom_fields: { "field-account": "maya.chen@testmail.identitysoon.com" } },
    });
    assert.deepEqual(updates[1], {
      data: { resource_subtype: "custom", custom_type_status_option: "s-eval" },
    });
    const fields = (updates[2] as { data: { custom_fields: Record<string, string> } }).data.custom_fields;
    assert.equal(fields["field-account"], "maya.chen@testmail.identitysoon.com");
    assert.equal(fields["field-code"], "261856");
    assert.equal(fields["field-status"], undefined);
    assert.deepEqual(updates[3], {
      data: { resource_subtype: "custom", custom_type_status_option: "s-implemented" },
    });
    assert.equal(fields["field-drive"], "opt-done");
  });

  it("finishes an Evaluation task from the saved account email when this server has no job", async () => {
    const email = "maya.chen@testmail.identitysoon.com";
    const { accounts, routes } = rememberedAccounts();
    accounts.push({
      id: "acct-1",
      nativeIdentity: email,
      identityId: "ident-1",
      attributes: { "e-mail": email, givenName: "Maya", familyName: "Chen" },
    });
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const status = await resumeAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { taskType: "Evaluation", accountEmail: email }) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(status?.email, email);
  });

  it("chooses the status field that contains New request, Evaluation, and Approved", () => {
    const fields = FIELD_SETTINGS.map((setting) => setting.custom_field) as AsanaCustomField[];
    assert.equal(statusField(fields, testDesk())?.gid, "field-status");
    assert.equal(fieldByName(fields, "Sandbox account")?.gid, "field-account");
  });

  it("hides the Asana token and SailPoint secret", () => {
    const file = `${process.cwd()}/data/asana-desk-test-${process.pid}.json`;
    const saved = saveAsanaDesk(
      { ...testDesk(), clientId: "desk-client", asanaToken: "asana-secret", clientSecret: "sail-secret" },
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

  it("refuses to save the back desk when the tenant link field is blank", () => {
    const file = `${process.cwd()}/data/asana-desk-missing-${process.pid}.json`;
    assert.throws(
      () =>
        saveAsanaDesk(
          {
            ...testDesk(),
            clientId: "desk-client",
            tenantLinkField: "",
            asanaToken: "asana-secret",
            clientSecret: "sail-secret",
          },
          file,
        ),
      /Tenant link field/,
    );
    assert.equal(fs.existsSync(file), false);
  });

  it("appends the account to the existing task description", async () => {
    const updates: unknown[] = [];
    const { routes } = rememberedAccounts();
    const { client } = fakeTenant({ ...READY_ROUTES, ...routes });
    const existing = "sailpoint.enterprise.slack.com/archives/C0\nSlack User ID: U0AUACHKTDF";
    await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch([], { updates, notes: existing }) as typeof fetch,
    });
    const saved = updates.find((update) => {
      const notes = (update as { data?: { notes?: string } }).data?.notes ?? "";
      return notes.includes("FULFILLMENT DETAILS");
    }) as { data: { notes: string } };
    assert.equal(
      saved.data.notes,
      `${existing}
--- FULFILLMENT DETAILS ---
TENANT_LINK: https://beta-25503.identitynow-demo.com
SANDBOX_ACCOUNT: maya.chen@testmail.identitysoon.com
INITIAL_PASSWORD: 261856
`,
    );
    assert.equal(saved.data.notes.split("--- FULFILLMENT DETAILS ---").length, 2);
  });

  it("replaces an existing fulfillment block instead of appending a second one", async () => {
    const updates: unknown[] = [];
    const { client } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "POST /v2025/set-password": () => ({ __httpStatus: 403, message: "Forbidden" }),
    });
    const job = waitingJob();
    job.user.password = "TestDrive9!";
    const existing = `Slack User ID: U0AUACHKTDF
--- FULFILLMENT DETAILS ---
TENANT_LINK: https://old.example
SANDBOX_ACCOUNT: old@testmail.identitysoon.com
INITIAL_PASSWORD: 000000
`;
    const [status] = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store: memoryStore([job]),
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { updates, notes: existing }) as typeof fetch,
    });
    assert.equal(status?.done, true);
    const notes = (updates[0] as { data: { notes: string } }).data.notes;
    assert.equal(
      notes,
      `Slack User ID: U0AUACHKTDF
--- FULFILLMENT DETAILS ---
TENANT_LINK: https://beta-25503.identitynow-demo.com
SANDBOX_ACCOUNT: luis.stone@example.com
INITIAL_PASSWORD: 261856
`,
    );
    assert.equal(notes.split("--- FULFILLMENT DETAILS ---").length, 2);
  });

  it("does not create an account or comment when the tenant link field is blank", async () => {
    const stories: unknown[] = [];
    const { client, calls } = fakeTenant(READY_ROUTES);
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore(),
      projectGid: "project-1",
      desk: { ...testDesk(), tenantLinkField: "" },
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(status.done, false);
    assert.equal(status.failed, false);
    assert.match(status.detail, /Tenant link field/);
    assert.equal(stories.length, 0);
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 0);
  });

  it("leaves a task alone on a server whose back desk is incomplete", async () => {
    const updates: unknown[] = [];
    const stories: unknown[] = [];
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const job = waitingJob();
    job.user.password = "TestDrive9!";
    const store = memoryStore([job]);
    const options = {
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: { ...testDesk(), tenantLinkField: "" },
      fetchImpl: asanaFetch(stories, { updates }) as typeof fetch,
    };
    const resumed = await resumeAsanaTask(TASK_GID, options);
    const ticked = await tickAsanaAccounts(options);
    assert.equal(resumed?.failed, false);
    assert.equal(resumed?.done, false);
    assert.match(resumed?.detail ?? "", /Tenant link field/);
    assert.deepEqual(ticked, []);
    assert.equal(stories.length, 0);
    assert.equal(updates.length, 0);
    assert.equal(calls.filter((call) => call.path.includes("generate-password-reset-token")).length, 0);
    assert.equal(store.load()[0]?.failed, undefined);
    assert.equal(store.load()[0]?.resetCode, undefined);
  });

  it("does not decline a finished task when two runs advance it at the same time", async () => {
    const updates: unknown[] = [];
    let codes = 0;
    const { client } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "POST /v2025/set-password": () => ({ __httpStatus: 403, message: "Forbidden" }),
      "POST /v2025/generate-password-reset-token/digit": () => {
        codes += 1;
        return codes === 1
          ? { digitToken: "261856", requestId: "req-1" }
          : { __httpStatus: 409, message: "A reset code already exists." };
      },
    });
    const job = waitingJob();
    job.user.password = "TestDrive9!";
    const store = memoryStore([job]);
    const options = {
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      desk: testDesk(),
      fetchImpl: asanaFetch([], { updates }) as typeof fetch,
    };
    const [first, second] = await Promise.all([tickAsanaAccounts(options), tickAsanaAccounts(options)]);
    assert.equal(codes, 1);
    assert.equal(first[0]?.failed, false);
    assert.equal(second[0]?.failed, false);
    assert.equal(second[0]?.done, true);
    assert.equal(store.load()[0]?.failed, undefined);
    assert.equal(store.load()[0]?.commented, true);
    assert.equal(
      updates.some((update) => JSON.stringify(update).includes("opt-declined")),
      false,
    );
  });

  it("does not decline a task that is already Implemented", async () => {
    const updates: unknown[] = [];
    const stories: unknown[] = [];
    const { client } = fakeTenant({
      ...READY_ROUTES,
      ...WAITING_ACCOUNT,
      "POST /v2025/set-password": () => ({ __httpStatus: 403, message: "Forbidden" }),
      "POST /v2025/generate-password-reset-token/digit": () => ({
        __httpStatus: 409,
        message: "A reset code already exists.",
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
      fetchImpl: asanaFetch(stories, { updates, taskType: "Implemented" }) as typeof fetch,
    });
    assert.equal(status?.failed, false);
    assert.equal(status?.done, true);
    assert.equal(stories.length, 0);
    assert.equal(updates.length, 0);
  });

  it("starts a new account when a declined task returns to New request", async () => {
    const { routes } = rememberedAccounts();
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...routes });
    const failed = waitingJob();
    failed.failed = true;
    failed.commented = true;
    const status = await acceptAsanaTask(TASK_GID, {
      token: "asana-token",
      client,
      store: memoryStore([failed]),
      projectGid: "project-1",
      desk: testDesk(),
      random: () => 0,
      fetchImpl: asanaFetch([]) as typeof fetch,
    });
    assert.equal(status.failed, false);
    assert.equal(status.email, "maya.chen@testmail.identitysoon.com");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
  });
});
