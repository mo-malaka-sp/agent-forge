import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { describe, it } from "node:test";

import {
  activateTestAccount,
  createTestAccount,
  encryptPassword,
  generateTestUser,
  NAME_LISTS,
  leadSePlusAddress,
  pickUniqueLeadSeCustomer,
  pickUniqueRequestedUser,
  pickUniqueUser,
  roleMembership,
  setupTenant,
} from "@/lib/readonly-account/tenant";
import { createSailPointClient, type SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";

function config(overrides: Partial<SailPointSetupConfig> = {}): SailPointSetupConfig {
  return {
    tenant: "beta-25503",
    apiBase: "https://beta-25503.api.identitynow-demo.com",
    clientId: "client-id",
    clientSecret: "client-secret",
    passwordClientId: "password-client-id",
    passwordClientSecret: "password-client-secret",
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "admin@example.com",
    ...overrides,
  };
}

type Call = { method: string; path: string; body: unknown };
type Route = (call: Call) => unknown;

function fakeTenant(routes: Record<string, Route>, clientConfig = config()) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/oauth/token") {
      calls.push({ method: "POST", path: "/oauth/token", body: String(init?.body ?? "") });
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
  return { client: createSailPointClient(clientConfig, fetchImpl), calls };
}

const SOURCE = {
  id: "src-td",
  name: "TestDriveUsers",
  owner: { id: "owner-1", name: "Admin", type: "IDENTITY" },
};
const TESTDRIVE_SCHEMA = {
  name: "account",
  identityAttribute: "e-mail",
  displayAttribute: "e-mail",
  attributes: ["givenName", "familyName", "e-mail", "type", "status"].map((name) => ({ name })),
};
const BASE_ROUTES: Record<string, Route> = {
  'GET /sources/v1?filters=name eq "TestDriveUsers"': () => [SOURCE],
  'GET /sources/v1?filters=name eq "IdentityNow"': () => [{ id: "src-idn", name: "IdentityNow" }],
  "GET /identity-profiles/v1": () => [
    { id: "profile-1", name: "Test Drive", authoritativeSource: { id: "src-td" } },
  ],
  "GET /sources/v1/src-td/schemas": () => [TESTDRIVE_SCHEMA],
  'GET /entitlements/v1?filters=name eq "SAF Admin"': () => [
    { id: "ent-other", name: "SAF Admin", source: { name: "Other" } },
    { id: "ent-saf", name: "SAF Admin", source: { id: "src-idn", name: "IdentityNow" } },
  ],
};

describe("read-only test account generation", () => {
  it("ignores a different identity returned for a plus-address search", async () => {
    const email = "mo.malaka+rosak@sailpoint.com";
    const { client } = fakeTenant({
      [`GET /identities/v1?filters=email eq "${email}"`]: () => [
        { name: "Mo Malaka", email: "mo.malaka@sailpoint.com" },
      ],
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "rosa.kim"': () => [],
      'GET /identities/v1?filters=alias eq "rosa.kim"': () => [],
    });
    const { user } = await pickUniqueRequestedUser(
      client as never,
      "src-admins",
      "Rosa",
      "Kim",
      email,
      () => 0,
    );
    assert.equal(user.id, "rosa.kim");
    assert.equal(user.email, email);
  });

  it("keeps a random customer when a plus search returns the Lead SE", async () => {
    const lead = "matt.brands@sailpoint.com";
    const { client } = fakeTenant({
      "GET /accounts/v1": () => [],
      "GET /identities/v1": () => [{ name: "Matt Brands", email: lead, alias: "matt.brands" }],
    });
    const { user, attempts } = await pickUniqueLeadSeCustomer(client as never, "src-admins", lead, () => 0);
    assert.equal(attempts, 1);
    assert.equal(user.id, "maya.chen");
    assert.equal(user.email, "matt.brands+maya.chen@sailpoint.com");
    assert.equal(user.name, "Maya Chen");
  });

  it("picks another name when the sign-in id or plus-address is already used", async () => {
    const lead = "matt.brands+existing@sailpoint.com";
    assert.equal(leadSePlusAddress(lead, "maya.chen"), "matt.brands+maya.chen@sailpoint.com");
    const { client } = fakeTenant({
      "GET /accounts/v1": () => [],
      "GET /identities/v1": (call) =>
        call.path.includes("matt.brands+maya.chen@sailpoint.com")
          ? [{ name: "Maya Chen", alias: "other.person", email: "matt.brands+maya.chen@sailpoint.com" }]
          : [],
    });
    const { user, attempts } = await pickUniqueLeadSeCustomer(client as never, "src-admins", lead, () => 0);
    assert.equal(user.id, "maya.chen22");
    assert.equal(user.email, "matt.brands+maya.chen22@sailpoint.com");
    assert.equal(attempts, 11);
  });

  it("gives one Lead SE a different customer on the next request", async () => {
    const used = new Set<string>();
    const { client } = fakeTenant({
      "GET /accounts/v1": (call) => {
        const id = call.path.match(/nativeIdentity eq "([^"]+)"/)?.[1] ?? "";
        return used.has(id) ? [{ id }] : [];
      },
      "GET /identities/v1": () => [],
    });
    const first = await pickUniqueLeadSeCustomer(
      client as never,
      "src-admins",
      "matt.brands@sailpoint.com",
      () => 0,
    );
    used.add(first.user.id);
    const second = await pickUniqueLeadSeCustomer(
      client as never,
      "src-admins",
      "matt.brands@sailpoint.com",
      () => 0,
    );
    assert.equal(first.user.id, "maya.chen");
    assert.equal(second.user.id, "maya.chen22");
    assert.notEqual(first.user.email, second.user.email);
  });

  it("uses short names, unambiguous digits, and the test mail domain", () => {
    const user = generateTestUser(2);
    const plain = generateTestUser(0, () => 0);
    assert.equal(plain.id, "maya.chen");
    assert.equal(plain.password, "TestDrive9!");
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
      "GET /identities/v1": (call) => {
        const alias = call.path.match(/alias eq "([^"]+)"/)?.[1];
        return alias ? [{ id: "someone", alias }] : [{ id: "someone" }];
      },
    });
    await assert.rejects(() => pickUniqueUser(client, "src-admins"), /after 30 attempts/);
  });
});

describe("read-only tenant setup", () => {
  it("creates the active state and role for TestDrive accounts", async () => {
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
        "Grants SAF Admin to TestDriveUsers accounts whose type is TestDrive.",
      owner: { type: "IDENTITY", id: "owner-1", name: "Admin" },
      enabled: true,
      requestable: false,
      accessProfiles: [],
      entitlements: [{ type: "ENTITLEMENT", id: "ent-saf" }],
      membership: roleMembership("src-td"),
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
      { op: "replace", path: "/membership", value: roleMembership("src-td") },
    ]);
    assert.equal(
      calls.some((call) => call.method === "POST" && call.path !== "/oauth/token"),
      false,
    );
  });

  it("reports a missing source instead of throwing", async () => {
    const { client } = fakeTenant({
      'GET /sources/v1?filters=name eq "TestDriveUsers"': () => [],
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /TestDriveUsers/);
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
    const attributes = (created?.body as { attributes?: Record<string, string> }).attributes;
    assert.equal(attributes?.["e-mail"], "maya.chen@testmail.identitysoon.com");
    assert.equal(attributes?.type, "TestDrive");
    assert.equal(attributes?.status, "active");
    assert.equal(attributes?.sourceId, "src-td");
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

  it("finds the TestDriveUsers account by its email", async () => {
    const email = "nina.nguyen@testmail.identitysoon.com";
    const { client, calls } = fakeTenant({
      [`GET /accounts/v1?filters=sourceId eq "src-td" and nativeIdentity eq "${email}"`]: () => [
        {
          id: "acct-1",
          nativeIdentity: email,
          identityId: null,
          attributes: { "e-mail": email },
        },
      ],
    });
    const result = await activateTestAccount(client, {
      ...input,
      userId: "nina.nguyen",
      sourceId: "src-td",
      sourceName: "TestDriveUsers",
      accountName: email,
    });
    assert.equal(result.phase, "identity-pending");
    assert.match(result.detail, /Waiting for the identity/);
    assert.equal(
      calls.some((call) => call.path.includes(`nativeIdentity eq "${email}"`)),
      true,
    );
  });

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

  it("invites the requester without redirecting tenant email", async () => {
    const { client, calls } = fakeTenant({
      'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "maya.chen42"':
        () => [{ id: "acct-1", nativeIdentity: "maya.chen42", identityId: "ident-1" }],
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", disabled: false },
      ],
      "POST /identities/v1/process": () => ({ id: "task-1" }),
      "GET /identities/v1/ident-1": () => ({
        id: "ident-1",
        alias: "maya.chen",
        lifecycleState: { stateName: "active" },
      }),
      "GET /identities/v1/ident-1/role-assignments": () => [
        { id: "assign-1", role: { name: "ReadOnly-Admins" } },
      ],
      "POST /beta/identities/invite": () => ({ id: "invite-task" }),
    });
    const result = await activateTestAccount(client, {
      ...input,
      sendInvite: true,
      inviteEmail: "maya.chen@example.com",
    });
    assert.equal(result.inviteSent, true);
    assert.equal(calls.some((call) => call.path.includes("email-test-mode")), false);
    assert.match(result.detail, /Invitation sent to maya.chen@example.com/);
    assert.match(result.detail, /expires in 7 days/);
  });
});

const PASSWORD_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
  type: "spki",
  format: "pem",
}).toString();

const READY_ACCOUNT = {
  'GET /accounts/v1?filters=sourceId eq "src-admins" and nativeIdentity eq "maya.chen42"': () => [
    { id: "acct-1", nativeIdentity: "maya.chen42", identityId: "ident-1" },
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
};

describe("TestDriveUsers accounts", () => {
  const routes = {
    ...BASE_ROUTES,
    "GET /identity-profiles/v1/profile-1/lifecycle-states": () => [
      { id: "state-active", technicalName: "active", enabled: true },
    ],
    'GET /roles/v1?filters=name eq "ReadOnly-Admins"': () => [
      { id: "role-1", name: "ReadOnly-Admins", enabled: true },
    ],
    "GET /accounts/v1": () => [],
    "GET /identities/v1": () => [],
    "POST /accounts/v1": () => ({ id: "task-create" }),
  };

  it("creates the account only on TestDriveUsers with type TestDrive", async () => {
    const { client, calls } = fakeTenant(routes);
    const result = await createTestAccount(client, () => 0);
    const created = calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1");
    assert.equal(created.length, 1);
    assert.deepEqual((created[0]?.body as { attributes: Record<string, string> }).attributes, {
      sourceId: "src-td",
      givenName: "Maya",
      familyName: "Chen",
      "e-mail": "maya.chen@testmail.identitysoon.com",
      type: "TestDrive",
      status: "active",
    });
    assert.equal(result.refs.accountNameIsEmail, true);
    assert.equal(result.refs.sourceId, "src-td");
  });

  it("stops when TestDriveUsers has no authoritative identity profile", async () => {
    const { client, calls } = fakeTenant({
      ...routes,
      "GET /identity-profiles/v1": () => [
        { id: "profile-1", name: "Admins", authoritativeSource: { id: "src-admins" } },
      ],
    });
    await assert.rejects(
      () => createTestAccount(client, () => 0),
      /No identity profile uses "TestDriveUsers" as its authoritative source/,
    );
    assert.equal(calls.filter((call) => call.method === "POST" && call.path === "/accounts/v1").length, 0);
  });

  it("stops setup when the TestDriveUsers schema has no type attribute", async () => {
    const { client } = fakeTenant({
      ...routes,
      "GET /sources/v1/src-td/schemas": () => [
        {
          ...TESTDRIVE_SCHEMA,
          attributes: TESTDRIVE_SCHEMA.attributes.filter((attribute) => attribute.name !== "type"),
        },
      ],
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /cannot be granted from TestDriveUsers/);
  });

  it("adds the TestDrive type rule beside an existing groups rule", async () => {
    const groupsRule = {
      operation: "CONTAINS",
      key: { type: "ACCOUNT", property: "attribute.groups", sourceId: "src-admins" },
      stringValue: "ReadOnly-Admins",
    };
    const { client, calls } = fakeTenant({
      ...routes,
      "GET /roles/v1/role-1": () => ({
        id: "role-1",
        enabled: true,
        entitlements: [{ id: "ent-saf" }],
        membership: { type: "STANDARD", criteria: { operation: "OR", children: [groupsRule] } },
      }),
      "PATCH /roles/v1/role-1": () => ({ id: "role-1" }),
    });
    const result = await setupTenant(client);
    assert.equal(result.ok, true);
    const patch = calls.find((call) => call.method === "PATCH" && call.path === "/roles/v1/role-1");
    assert.deepEqual(patch?.body, [
      {
        op: "replace",
        path: "/membership",
        value: {
          type: "STANDARD",
          criteria: {
            operation: "OR",
            children: [groupsRule, roleMembership("src-td").criteria.children[0]],
          },
        },
      },
    ]);
  });
});

describe("IdentityNow password", () => {
  const input = {
    userId: "maya.chen42",
    sourceId: "src-admins",
    profileId: "profile-1",
    activeStateId: "state-active",
    identityNowSourceId: "src-idn",
    attempt: 0,
    processed: false,
    password: "TestDrive9!",
    sendInvite: true,
    inviteEmail: "maya.chen42@example.com",
  };

  it("sets the password with the IdentityNow account id and a scoped token", async () => {
    const { client, calls } = fakeTenant({
      ...READY_ACCOUNT,
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", nativeIdentity: "maya.chen42", disabled: false },
      ],
      "POST /query-password-info/v1": () => ({
        identityId: "ident-1",
        sourceId: "src-idn",
        publicKeyId: "key-1",
        publicKey: PASSWORD_KEY,
        accounts: [{ accountId: "maya.chen42" }],
      }),
      "POST /set-password/v1": () => ({}),
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.passwordSet, true);
    assert.equal(result.inviteSent, true);
    const query = calls.find((call) => call.path === "/query-password-info/v1");
    assert.deepEqual(query?.body, { userName: "maya.chen42", sourceName: "IdentityNow" });
    const setPassword = calls.find((call) => call.path === "/set-password/v1");
    const body = setPassword?.body as { accountId?: string; identityId?: string; publicKeyId?: string };
    assert.equal(body.accountId, "maya.chen42");
    assert.equal(body.identityId, "ident-1");
    assert.equal(body.publicKeyId, "key-1");
    const scoped = calls.find(
      (call) => call.path === "/oauth/token" && decodeURIComponent(String(call.body)).includes("scope=sp:scopes:all"),
    );
    const shared = calls.find(
      (call) => call.path === "/oauth/token" && !decodeURIComponent(String(call.body)).includes("scope="),
    );
    assert.match(decodeURIComponent(String(scoped?.body ?? "")), /client_id=password-client-id/);
    assert.match(decodeURIComponent(String(shared?.body ?? "")), /client_id=client-id/);
  });

  it("still sends the invitation when set-password is forbidden", async () => {
    const { client, calls } = fakeTenant({
      ...READY_ACCOUNT,
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", nativeIdentity: "maya.chen42", disabled: false },
      ],
      "POST /query-password-info/v1": () => ({
        identityId: "ident-1",
        sourceId: "src-idn",
        publicKeyId: "key-1",
        publicKey: PASSWORD_KEY,
        accounts: [{ accountId: "maya.chen42" }],
      }),
      "POST /set-password/v1": () => ({ __httpStatus: 403, message: "Forbidden" }),
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.passwordSet, false);
    assert.match(result.passwordError ?? "", /sp:scopes:all/);
    assert.equal(result.inviteSent, true);
    assert.equal(result.done, true);
    assert.ok(calls.some((call) => call.path === "/beta/identities/invite"));
  });

  it("keeps the identity active when the password client has no user", async () => {
    const { client, calls } = fakeTenant({
      ...READY_ACCOUNT,
      'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
        { id: "idn-1", nativeIdentity: "maya.chen42", disabled: false },
      ],
      "POST /query-password-info/v1": () => ({
        __httpStatus: 500,
        errorName: "IllegalStateException",
        errorMessage: "there is no valid identityId in the current RequestContext",
      }),
    });
    const result = await activateTestAccount(client, input);
    assert.equal(result.done, true);
    assert.equal(result.passwordSet, false);
    assert.match(result.passwordError ?? "", /personal access token/);
    assert.equal(result.inviteSent, true);
    assert.equal(calls.some((call) => call.path === "/set-password/v1"), false);
  });

  it("names the password environment variables when that API client is not configured", async () => {
    const { client, calls } = fakeTenant(
      {
        ...READY_ACCOUNT,
        'GET /accounts/v1?filters=identityId eq "ident-1" and sourceId eq "src-idn"': () => [
          { id: "idn-1", nativeIdentity: "maya.chen42", disabled: false },
        ],
      },
      config({ passwordClientId: "", passwordClientSecret: "" }),
    );
    const result = await activateTestAccount(client, input);
    assert.equal(result.passwordSet, false);
    assert.match(result.passwordError ?? "", /SAF_PASSWORD_CLIENT_ID/);
    assert.equal(result.inviteSent, true);
    assert.equal(
      calls.some((call) => call.path === "/set-password/v1"),
      false,
    );
  });
});

