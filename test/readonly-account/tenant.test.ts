import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  activateTestAccount,
  generateTestUser,
  NAME_LISTS,
  pickUniqueUser,
  roleMembership,
  setupTenant,
} from "@/lib/readonly-account/tenant";
import { createSailPointClient, type SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";

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
type Route = (call: Call) => unknown;

function fakeTenant(routes: Record<string, Route>) {
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

const SOURCE = { id: "src-admins", name: "ISC Admins", owner: { id: "owner-1", name: "Admin", type: "IDENTITY" } };
const BASE_ROUTES: Record<string, Route> = {
  'GET /sources/v1?filters=name eq "ISC Admins"': () => [SOURCE],
  'GET /sources/v1?filters=name eq "IdentityNow"': () => [{ id: "src-idn", name: "IdentityNow" }],
  "GET /identity-profiles/v1": () => [
    { id: "profile-1", name: "Admins", authoritativeSource: { id: "src-admins" } },
  ],
  'GET /entitlements/v1?filters=name eq "SAF Admin"': () => [
    { id: "ent-other", name: "SAF Admin", source: { name: "Other" } },
    { id: "ent-saf", name: "SAF Admin", source: { name: "IdentityNow" } },
  ],
};

describe("read-only test account generation", () => {
  it("uses short names, unambiguous digits, and the test mail domain", () => {
    const user = generateTestUser(2);
    assert.match(user.id, /^[a-z]+\.[a-z]+[2-9]{2}$/);
    assert.equal(user.email, `${user.id}@testmail.identitysoon.com`);
    assert.equal(user.name, `${user.givenName} ${user.familyName}`);
    for (const name of [...NAME_LISTS.first, ...NAME_LISTS.last]) {
      assert.doesNotMatch(name, /(.)\1/, name);
    }
    assert.doesNotMatch(NAME_LISTS.digits, /[01]/);
  });

  it("regenerates when the id or email is already used", async () => {
    let accountChecks = 0;
    const { client } = fakeTenant({
      "GET /accounts/v1": () => {
        accountChecks += 1;
        return accountChecks === 1 ? [{ id: "taken" }] : [];
      },
      "GET /identities/v1": () => [],
    });
    const result = await pickUniqueUser(client, "src-admins");
    assert.equal(result.attempts, 2);
  });

  it("switches to three digits after ten collisions, then stops", async () => {
    const { client } = fakeTenant({
      "GET /accounts/v1": () => [],
      "GET /identities/v1": () => [{ id: "someone" }],
    });
    await assert.rejects(() => pickUniqueUser(client, "src-admins"), /after 20 attempts/);
  });
});

describe("read-only tenant setup", () => {
  it("creates the active state and role with SAF Admin and the groups criteria", async () => {
    const { client, calls } = fakeTenant({
      ...BASE_ROUTES,
      "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [],
      "POST /identity-profiles/v1/profile-1/lifecycle-states": () => ({ id: "state-active" }),
      'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [],
      "POST /roles/v1": () => ({ id: "role-1" }),
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, true);
    const role = calls.find((call) => call.method === "POST" && call.path === "/roles/v1");
    assert.deepEqual(role?.body, {
      name: "ReadOnly-Admins",
      description:
        "Grants SAF Admin to ISC Admins accounts whose groups contain ReadOnly-Admins.",
      owner: { type: "IDENTITY", id: "owner-1", name: "Admin" },
      enabled: true,
      requestable: false,
      accessProfiles: [],
      entitlements: [{ type: "ENTITLEMENT", id: "ent-saf" }],
      membership: roleMembership("src-admins"),
    });
    assert.deepEqual(
      result.steps.map((step) => step.status),
      ["found", "found", "created", "found", "created"],
    );
  });

  it("repairs an existing role without recreating it", async () => {
    const { client, calls } = fakeTenant({
      ...BASE_ROUTES,
      "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [
        { id: "state-active", technicalName: "active", enabled: true },
      ],
      'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [
        { id: "role-1", name: "ReadOnly-Admins" },
      ],
      "GET /roles/v1/role-1": () => ({
        id: "role-1",
        name: "ReadOnly-Admins",
        enabled: false,
        entitlements: [{ id: "ent-saf" }],
        membership: null,
      }),
      "PATCH /roles/v1/role-1": () => ({ id: "role-1" }),
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, true);
    const patch = calls.find((call) => call.method === "PATCH");
    assert.deepEqual(patch?.body, [
      { op: "replace", path: "/enabled", value: true },
      { op: "replace", path: "/membership", value: roleMembership("src-admins") },
    ]);
    assert.equal(calls.some((call) => call.method === "POST"), false);
  });

  it("reports a missing source instead of throwing", async () => {
    const { client } = fakeTenant({
      'GET /sources/v1?filters=name eq "ISC Admins"': () => [],
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ISC Admins/);
  });
});

describe("read-only account activation", () => {
  const input = {
    userId: "maya.chen42",
    sourceId: "src-admins",
    profileId: "profile-1",
    activeStateId: "state-active",
    identityNowSourceId: "src-idn",
    attempt: 0,
    processed: false,
  };

  it("waits while the account has no identity yet", async () => {
    const { client } = fakeTenant({
      "GET /accounts/v1": () => [{ id: "acct-1", identityId: null }],
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.phase, "identity-pending");
    assert.equal(result.done, false);
  });

  it("processes, activates, and enables the identity until the role is assigned", async () => {
    const { client, calls } = fakeTenant({
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "maya.chen42"':
        () => [{ id: "acct-1", identityId: "ident-1" }],
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", disabled: true },
      ],
      "POST /identities/v1/process": () => ({ id: "task-1" }),
      "GET /identities/v1/ident-1": () => ({ id: "ident-1", lifecycleState: { stateName: "inactive" } }),
      "POST /identities/v1/ident-1/set-lifecycle-state": () => ({}),
      "POST /identities-accounts/v1/ident-1/enable": () => ({ id: "task-2" }),
      "GET /identities/v1/ident-1/role-assignments": () => [
        { id: "assign-1", role: { name: "ReadOnly-Admins" } },
      ],
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.done, true);
    assert.equal(result.lifecycleState, "active");
    assert.equal(result.accountEnabled, true);
    const process = calls.find((call) => call.path === "/identities/v1/process");
    assert.deepEqual(process?.body, { identityIds: ["ident-1"] });
    const lifecycle = calls.find((call) => call.path.endsWith("/set-lifecycle-state"));
    assert.deepEqual(lifecycle?.body, { lifecycleStateId: "state-active" });
  });
});
