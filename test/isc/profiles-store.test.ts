import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  deleteProfile,
  ensureLegacyTenantsMigrated,
  getBindings,
  getProfile,
  profileForFeature,
  resetProfilesMigrationForTests,
  saveProfile,
  setBinding,
  updateProfileSources,
} from "@/lib/isc/profiles-store";
import { createFileStore, type SafPocStore } from "@/lib/saf-poc/storage";

let dir: string;
let store: SafPocStore;

const ENV_KEYS = [
  "AWS_EXECUTION_ENV",
  "SAF_POC_TABLE_NAME",
  "SAF_TENANT",
  "SAF_CLIENT_ID",
  "SAF_CLIENT_SECRET",
  "SAF_API_BASE",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-store-"));
  store = createFileStore(path.join(dir, "state.json"));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetProfilesMigrationForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const acme = {
  name: "Acme demo",
  tenant: "beta-1",
  domain: "identitynow-demo.com",
  clientId: "client-acme",
  clientSecret: "secret-acme",
};

describe("saved tenant profiles", () => {
  it("never returns the client secret to the browser", async () => {
    const pub = await saveProfile(acme, { store });
    assert.equal("clientSecret" in pub, false);
    assert.equal("passwordClientSecret" in pub, false);
    assert.equal(pub.clientSecretSet, true);
    assert.equal(pub.tenantUrl, "https://beta-1.identitynow-demo.com/");
  });

  it("keeps the stored secret when an edit leaves the secret blank", async () => {
    const created = await saveProfile(acme, { store });
    await saveProfile({ ...acme, name: "Renamed", clientSecret: "" }, { id: created.id, store });
    const stored = await getProfile(created.id, store);
    assert.equal(stored?.name, "Renamed");
    assert.equal(stored?.clientSecret, "secret-acme");
  });

  it("replaces the stored secret when an edit supplies one", async () => {
    const created = await saveProfile(acme, { store });
    await saveProfile({ ...acme, clientSecret: "new-secret" }, { id: created.id, store });
    assert.equal((await getProfile(created.id, store))?.clientSecret, "new-secret");
  });

  it("clears a source ID when the form sends it blank", async () => {
    const created = await saveProfile(
      { ...acme, sources: { aws_bedrock: "src-1" } },
      { store },
    );
    await saveProfile({ ...acme, sources: { aws_bedrock: "" } }, { id: created.id, store });
    assert.deepEqual((await getProfile(created.id, store))?.sources, {});
  });

  it("updates one source ID and keeps the others, and clears a blank one", async () => {
    const created = await saveProfile(
      { ...acme, sources: { aws_bedrock: "aws-1", gcp_vertex: "gcp-1" } },
      { store },
    );
    await updateProfileSources(created.id, { aws_bedrock: "aws-2" }, store);
    assert.deepEqual((await getProfile(created.id, store))?.sources, {
      aws_bedrock: "aws-2",
      gcp_vertex: "gcp-1",
    });
    await updateProfileSources(created.id, { gcp_vertex: "" }, store);
    assert.deepEqual((await getProfile(created.id, store))?.sources, { aws_bedrock: "aws-2" });
  });

  it("requires a secret for a new profile", async () => {
    await assert.rejects(
      () => saveProfile({ ...acme, clientSecret: "" }, { store }),
      /Client secret is required/,
    );
  });

  it("resolves a feature to its binding, else the default", async () => {
    const first = await saveProfile({ ...acme, name: "Default" }, { store });
    const second = await saveProfile({ ...acme, name: "CAEP", tenant: "beta-2" }, { store });
    await setBinding("default", first.id, store);
    await setBinding("caep", second.id, store);

    assert.equal((await profileForFeature("caep", store))?.id, second.id);
    assert.equal((await profileForFeature("datadog", store))?.id, first.id);
    await setBinding("caep", null, store);
    assert.equal((await profileForFeature("caep", store))?.id, first.id);
  });

  it("makes the first saved tenant the default and keeps it when more are added", async () => {
    const first = await saveProfile({ ...acme, name: "First" }, { store });
    assert.equal((await getBindings(store)).default, first.id);
    await saveProfile({ ...acme, name: "Second", tenant: "beta-2" }, { store });
    assert.equal((await getBindings(store)).default, first.id);
  });

  it("returns no profile when nothing is saved", async () => {
    assert.equal(await profileForFeature("ask", store), null);
  });

  it("refuses to delete a tenant that a feature still uses", async () => {
    const profile = await saveProfile(acme, { store });
    await setBinding("ask", profile.id, store);
    await assert.rejects(() => deleteProfile(profile.id, store), /used by .*Ask this tenant/);
    await setBinding("ask", null, store);
    await setBinding("default", null, store);
    await deleteProfile(profile.id, store);
    assert.equal(await getProfile(profile.id, store), null);
  });

  it("refuses to bind an unknown profile", async () => {
    await assert.rejects(() => setBinding("govern", "missing", store), /not found/);
  });

  it("refuses to write on a deployed server without the shared table", async () => {
    process.env.AWS_EXECUTION_ENV = "AWS_Lambda_nodejs22.x";
    await assert.rejects(
      () => saveProfile(acme),
      /Set SAF_POC_TABLE_NAME in Amplify and redeploy/,
    );
  });
});

describe("migration of existing tenants", () => {
  it("copies the env tenant and the Test Drive desk tenant into profiles, once", async () => {
    process.env.SAF_TENANT = "beta-env";
    process.env.SAF_CLIENT_ID = "env-client";
    process.env.SAF_CLIENT_SECRET = "env-secret";
    process.env.SAF_API_BASE = "https://beta-env.api.identitynow-demo.com";
    await store.put("READONLY_ACCOUNT#asana-desk", {
      tenant: "beta-desk",
      clientId: "desk-client",
      clientSecret: "desk-secret",
    });

    await ensureLegacyTenantsMigrated(store);
    const bindings = await getBindings(store);
    const envProfile = await getProfile(bindings.default ?? "", store);
    const deskProfile = await getProfile(bindings["test-drive"] ?? "", store);

    assert.equal(envProfile?.tenant, "beta-env");
    assert.equal(envProfile?.domain, "identitynow-demo.com");
    assert.equal(deskProfile?.tenant, "beta-desk");
    assert.equal(deskProfile?.clientSecret, "desk-secret");

    const before = await store.list("ISC_PROFILE#");
    resetProfilesMigrationForTests();
    await ensureLegacyTenantsMigrated(store);
    assert.equal((await store.list("ISC_PROFILE#")).length, before.length);
  });

  it("does not copy a tenant twice when env and desk point at the same client", async () => {
    process.env.SAF_TENANT = "beta-same";
    process.env.SAF_CLIENT_ID = "same-client";
    process.env.SAF_CLIENT_SECRET = "same-secret";
    await store.put("READONLY_ACCOUNT#asana-desk", {
      tenant: "beta-same",
      clientId: "same-client",
      clientSecret: "same-secret",
    });

    await ensureLegacyTenantsMigrated(store);
    const sameTenant = (await store.list<{ tenant: string }>("ISC_PROFILE#")).filter(
      (entry) => entry.value.tenant === "beta-same",
    );
    assert.equal(sameTenant.length, 1);
    const bindings = await getBindings(store);
    assert.equal(bindings["test-drive"], bindings.default);
  });
});
