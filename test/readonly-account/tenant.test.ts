import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { describe, it } from "node:test";

import {
  activateTestAccount,
  createTestAccount,
  encryptPassword,
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
    { id: "ent-saf", name: "SAF Admin", source: { id: "src-idn", name: "IdentityNow" } },
  ],
};

describe("read-only test account generation", () => {
  it("uses short names, unambiguous digits, and the test mail domain", () => {
    const user = generateTestUser(2);
    const plain = generateTestUser(0, () => 0);
    assert.equal(plain.id, "maya.chen");
    assert.match(user.id, /^[a-z]+\.[a-z]+[2-9]{2}$/);
    assert.equal(user.email, `${user.id}@testmail.identitysoon.com`);
    assert.match(user.password, /^TestDrive[2-9]{2}!$/);
    assert.equal(user.name, `${user.givenName} ${user.familyName}`);
    for (const name of [...NAME_LISTS.first, ...NAME_LISTS.last]) {
      assert.doesNotMatch(name, /(.)\1/, name);
    }
    assert.doesNotMatch(NAME_LISTS.digits, /[01]/);
  });

  it("encrypts a password with the SailPoint RSA padding", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encrypted = encryptPassword(publicKey.export({ type: "spki", format: "pem" }).toString(), "TestDrive25!");
    const decrypted = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(encrypted, "base64"),
    );
    assert.equal(decrypted.toString(), "TestDrive25!");
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
    await assert.rejects(() => pickUniqueUser(client, "src-admins"), /after 30 attempts/);
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

describe("read-only account creation", () => {
  it("uses the SAF Admin entitlement source instead of listing IdentityNow", async () => {
    const routes = { ...BASE_ROUTES };
    delete routes['GET /sources/v1?filters=name eq "IdentityNow"'];
    const { client, calls } = fakeTenant({
      ...routes,
      "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [
        { id: "state-active", technicalName: "active", enabled: true },
      ],
      'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [
        { id: "role-1", name: "ReadOnly-Admins", enabled: true },
      ],
      "GET /accounts/v1": () => [],
      "GET /identities/v1": () => [],
      "POST /accounts/v1": () => ({ id: "task-create" }),
    });
    const result = await createTestAccount(client, () => 0);
    const created = calls.find((call) => call.method === "POST" && call.path === "/accounts/v1");
    const attributes = (created?.body as { attributes?: { id?: string; name?: string } }).attributes;
    assert.equal(attributes?.id, "maya.chen");
    assert.equal(attributes?.name, "maya.chen");
    assert.equal(result.user.name, "Maya Chen");
    assert.equal(result.refs.identityNowSourceId, "src-idn");
    assert.equal(result.emailRedirect, null);
    assert.equal(
      calls.some((call) => call.path.includes("IdentityNow")),
      false,
    );
    assert.equal(
      calls.some((call) => call.path.includes("email-test-mode")),
      false,
    );
  });

  it("redirects tenant emails before creating the account", async () => {
    const { client, calls } = fakeTenant({
      ...BASE_ROUTES,
      "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [
        { id: "state-active", technicalName: "active", enabled: true },
      ],
      'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [
        { id: "role-1", name: "ReadOnly-Admins", enabled: true },
      ],
      "PUT /beta/notification-preferences/email-test-mode": () => ({
        emailTestMode: true,
        emailTestAddress: "se@example.com",
      }),
      "GET /accounts/v1": () => [],
      "GET /identities/v1": () => [],
      "POST /accounts/v1": () => ({ id: "task-create" }),
    });
    const result = await createTestAccount(client, () => 0, "  se@example.com  ");
    assert.equal(result.emailRedirect, "se@example.com");
    const redirect = calls.find((call) => call.path.includes("email-test-mode"));
    const create = calls.find((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.deepEqual(redirect?.body, {
      emailTestMode: true,
      emailTestAddress: "se@example.com",
    });
    assert.ok(redirect && create);
    assert.ok(calls.indexOf(redirect) < calls.indexOf(create));
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

  it("does not treat an existing ISC Admins account as the new user", async () => {
    const { client, calls } = fakeTenant({
      "GET /accounts/v1": () => [
        { id: "acct-existing", nativeIdentity: "mo.malaka", identityId: "ident-existing" },
      ],
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.done, false);
    assert.equal(result.phase, "account-pending");
    assert.equal(calls.some((call) => call.path.includes("ident-existing")), false);
  });

  it("waits while the account has no identity yet", async () => {
    const { client } = fakeTenant({
      "GET /accounts/v1": () => [{ id: "acct-1", nativeIdentity: "maya.chen42", identityId: null }],
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.phase, "identity-pending");
    assert.equal(result.done, false);
  });

  it("processes, activates, and enables the identity until the role is assigned", async () => {
    const { client, calls } = fakeTenant({
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "maya.chen42"':
        () => [{ id: "acct-1", nativeIdentity: "maya.chen42", identityId: "ident-1" }],
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", disabled: true },
      ],
      "POST /identities/v1/process": () => ({ id: "task-1" }),
      "GET /identities/v1/ident-1": () => ({
        id: "ident-1",
        alias: "maya.chen42",
        lifecycleState: { stateName: "inactive" },
      }),
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
    assert.equal(calls.some((call) => call.path === "/beta/identities/invite"), false);
  });

  it("invites the identity when tenant email is redirected", async () => {
    const { client, calls } = fakeTenant({
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "maya.chen42"':
        () => [{ id: "acct-1", nativeIdentity: "maya.chen42", identityId: "ident-1" }],
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", disabled: false },
      ],
      "POST /identities/v1/process": () => ({ id: "task-1" }),
      "GET /identities/v1/ident-1": () => ({
        id: "ident-1",
        alias: "Maya Chen",
        lifecycleState: { stateName: "active" },
      }),
      "GET /identities/v1/ident-1/role-assignments": () => [
        { id: "assign-1", role: { name: "ReadOnly-Admins" } },
      ],
      "POST /beta/identities/invite": () => ({ id: "invite-task" }),
    });
    const result = await activateTestAccount(client, {
      ...input,
      redirectEmail: "se@example.com",
    });
    assert.equal(result.done, true);
    assert.equal(result.inviteSent, true);
    const invite = calls.find((call) => call.path === "/beta/identities/invite");
    assert.deepEqual(invite?.body, { ids: ["ident-1"], uninvited: false });
    assert.match(result.detail, /se@example.com/);
  });
});
