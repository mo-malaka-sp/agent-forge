import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  acceptAsanaTask,
  finishPendingAsanaAccounts,
  leadSeFromAsanaTask,
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

function asanaFetch(
  stories: unknown[],
  options: {
    task?: Record<string, unknown>;
    users?: Record<string, { email?: string; name?: string }>;
    failMove?: boolean;
    inAssigned?: boolean;
    sections?: Array<{ gid: string; name: string }>;
    moves?: unknown[];
    urls?: string[];
  } = {},
) {
  const moves = options.moves ?? [];
  const urls = options.urls ?? [];
  const sections = options.sections ?? [
    { gid: "section-ready", name: "Ready for TES" },
    { gid: "section-assigned", name: "Assigned" },
  ];
  const fetchImpl: typeof fetch = async (url, init) => {
    const target = String(url);
    urls.push(target);
    const method = init?.method ?? "GET";
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
          nativeIdentity: attributes.id,
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

  it("creates a random customer for the Lead SE and moves the task to Assigned", async () => {
    const stories: unknown[] = [];
    const moves: unknown[] = [];
    const urls: string[] = [];
    const { accounts, routes } = rememberedAccounts();
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...routes });
    const store = memoryStore();
    const options = {
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      fetchImpl: asanaFetch(stories, { moves, urls }) as typeof fetch,
      random: () => 0,
    };
    const first = await acceptAsanaTask(TASK_GID, options);
    assert.equal(first.userId, "maya.chen");
    assert.equal(first.email, "matt.brands+maya.chen@sailpoint.com");
    assert.equal(first.done, true);
    assert.notEqual(first.userId, "state.farm");
    const created = calls.find((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.deepEqual((created?.body as { attributes: Record<string, string> }).attributes, {
      sourceId: "src-admins",
      id: "maya.chen",
      name: "maya.chen",
      givenName: "Maya",
      familyName: "Chen",
      "e-mail": "matt.brands+maya.chen@sailpoint.com",
      location: `SAF Test Drive asana:${TASK_GID}`,
      groups: "ReadOnly-Admins",
    });
    assert.equal(calls.filter((call) => call.path.includes("email-test-mode")).length, 0);
    assert.ok(urls.some((url) => url.includes("custom_fields.people_value.email")));
    assert.deepEqual(moves, [{ data: { task: TASK_GID } }]);

    const second = await acceptAsanaTask(TASK_GID, options);
    assert.equal(second.userId, "maya.chen");
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 1);
    assert.equal(stories.length, 1);
    assert.equal(moves.length, 1);
    assert.match(JSON.stringify(stories[0]), /Username: maya.chen/);
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
    assert.equal(status.email, "matt.brands+maya.chen@sailpoint.com");
    assert.equal(status.done, true);
  });

  it("does not create an account when the task has no Lead SE", async () => {
    const { client, calls } = fakeTenant(READY_ROUTES);
    await assert.rejects(
      () =>
        acceptAsanaTask(TASK_GID, {
          token: "asana-token",
          client,
          store: memoryStore(),
          fetchImpl: asanaFetch([], { task: { name: "State Farm Mutual", custom_fields: [] } }) as typeof fetch,
        }),
      /The task needs a Lead SE\./,
    );
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 0);
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
      fetchImpl: asanaFetch(stories) as typeof fetch,
      random: () => 0,
    };
    const first = await acceptAsanaTask(TASK_GID, options);
    const second = await acceptAsanaTask("1234567890124", options);
    assert.equal(first.userId, "maya.chen");
    assert.equal(first.email, "matt.brands+maya.chen@sailpoint.com");
    assert.equal(second.userId, "maya.chen22");
    assert.equal(second.email, "matt.brands+maya.chen22@sailpoint.com");
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
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(status?.done, true);
    assert.equal(status?.userId, "luis.stone");
    assert.equal(stories.length, 1);
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
      fetchImpl: asanaFetch(stories, { moves }) as typeof fetch,
    });
    assert.equal(status?.done, false);
    assert.equal(moves.length, 0);
    assert.equal(stories.length, 1);
    assert.match(JSON.stringify(stories[0]), /Username: luis.stone/);
  });

  it("retries the move to Assigned without creating another account", async () => {
    const stories: unknown[] = [];
    const moves: unknown[] = [];
    const { client, calls } = fakeTenant({ ...READY_ROUTES, ...WAITING_ACCOUNT });
    const store = memoryStore([waitingJob()]);
    const first = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      fetchImpl: asanaFetch(stories, { moves, failMove: true }) as typeof fetch,
    });
    assert.equal(first[0]?.done, false);
    assert.equal(moves.length, 0);
    assert.match(JSON.stringify(stories), /could not be moved to Assigned/);

    const second = await tickAsanaAccounts({
      token: "asana-token",
      client,
      store,
      projectGid: "project-1",
      fetchImpl: asanaFetch(stories, { moves }) as typeof fetch,
    });
    assert.equal(second[0]?.done, true);
    assert.deepEqual(moves, [{ data: { task: TASK_GID } }]);
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
      'GET /accounts/v1?filters=sourceId eq "src-admins"': () => [
        {
          id: "acct-rosa",
          nativeIdentity: "rosa.stone",
          identityId: "ident-rosa",
          attributes: {
            id: "rosa.stone",
            givenName: "Rosa",
            familyName: "Stone",
            "e-mail": "mo.malaka+rosa@sailpoint.com",
            location: `SAF Test Drive asana:${TASK_GID}`,
          },
        },
      ],
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "rosa.stone"': () => [
        {
          id: "acct-rosa",
          nativeIdentity: "rosa.stone",
          identityId: "ident-rosa",
          attributes: { id: "rosa.stone" },
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
      fetchImpl: asanaFetch(stories) as typeof fetch,
    });
    assert.equal(statuses[0]?.done, true);
    assert.equal(statuses[0]?.userId, "rosa.stone");
    assert.match(statuses[0]?.detail ?? "", /Invitation sent to mo.malaka\+rosa@sailpoint.com/);
    assert.ok(calls.some((call) => call.method === "POST" && call.path.includes("set-lifecycle-state")));
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });
});
