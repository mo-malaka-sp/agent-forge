import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  clearFeatureTenantCache,
  resolveFeatureRuntime,
} from "@/lib/isc/feature-tenant";
import {
  profileRuntime,
  resetProfilesMigrationForTests,
  saveProfile,
  setBinding,
  getProfile,
} from "@/lib/isc/profiles-store";
import { getActiveIscRuntime, runWithIscRuntimeAsync } from "@/lib/isc/runtime-config";
import { getIscSourceId } from "@/lib/isc/settings-store";
import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { createFileStore, type SafPocStore } from "@/lib/saf-poc/storage";

let dir: string;
let store: SafPocStore;
const ENV_KEYS = ["SAF_TENANT", "SAF_CLIENT_ID", "SAF_CLIENT_SECRET", "SAF_API_BASE", "ISC_TENANT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-tenant-"));
  store = createFileStore(path.join(dir, "state.json"));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  clearFeatureTenantCache();
  resetProfilesMigrationForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  clearFeatureTenantCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function twoTenants() {
  const defaultTenant = await saveProfile(
    {
      name: "Default",
      tenant: "beta-default",
      domain: "identitynow-demo.com",
      clientId: "default-client",
      clientSecret: "default-secret",
    },
    { store },
  );
  const caepTenant = await saveProfile(
    {
      name: "CAEP",
      tenant: "beta-caep",
      domain: "identitynow-demo.com",
      clientId: "caep-client",
      clientSecret: "caep-secret",
      passwordClientId: "caep-pw-client",
      passwordClientSecret: "caep-pw-secret",
      ownerId: "owner-1",
      notifyEmail: "owner@example.com",
    },
    { store },
  );
  await setBinding("default", defaultTenant.id, store);
  await setBinding("caep", caepTenant.id, store);
  return { defaultTenant, caepTenant };
}

describe("per-feature tenant resolution", () => {
  it("each feature gets its own tenant, and unbound features get the default", async () => {
    await twoTenants();
    const caep = await resolveFeatureRuntime("caep", store);
    const datadog = await resolveFeatureRuntime("datadog", store);

    assert.equal(caep?.tenant, "beta-caep");
    assert.equal(datadog?.tenant, "beta-default");
  });

  it("returns undefined when nothing is saved, so env settings still apply", async () => {
    assert.equal(await resolveFeatureRuntime("ask", store), undefined);
  });

  it("uses a cached answer until the cache is cleared", async () => {
    const { caepTenant } = await twoTenants();
    assert.equal((await resolveFeatureRuntime("caep", store))?.tenant, "beta-caep");

    await setBinding("caep", null, store);
    assert.equal((await resolveFeatureRuntime("caep", store))?.tenant, "beta-caep");

    clearFeatureTenantCache();
    assert.equal((await resolveFeatureRuntime("caep", store))?.tenant, "beta-default");
    assert.ok(await getProfile(caepTenant.id, store));
  });
});

describe("source IDs follow the bound tenant", () => {
  it("uses the bound profile's source IDs and never another tenant's", async () => {
    const profile = await saveProfile(
      {
        name: "Sources",
        tenant: "beta-src",
        domain: "identitynow-demo.com",
        clientId: "src-client",
        clientSecret: "src-secret",
        sources: { aws_bedrock: "src-aws" },
      },
      { store },
    );
    const bound = await getProfile(profile.id, store);
    assert.ok(bound);

    const ids = await runWithIscRuntimeAsync(profileRuntime(bound), async () => ({
      aws: getIscSourceId("aws_bedrock"),
      gcp: getIscSourceId("gcp_vertex"),
    }));
    assert.equal(ids.aws, "src-aws");
    assert.equal(ids.gcp, null);
  });
});

describe("loadSafPocConfig honors the active tenant", () => {
  it("reads the tenant, credentials and SAF fields from the bound profile", async () => {
    // The env says one tenant, the bound profile says another. The profile wins.
    process.env.SAF_TENANT = "beta-env";
    process.env.SAF_CLIENT_ID = "env-client";
    process.env.SAF_CLIENT_SECRET = "env-secret";
    const { caepTenant } = await twoTenants();
    const profile = await getProfile(caepTenant.id, store);
    assert.ok(profile);

    const config = await runWithIscRuntimeAsync(profileRuntime(profile), async () => {
      assert.equal(getActiveIscRuntime()?.profile_name, "CAEP");
      return loadSafPocConfig();
    });

    assert.equal(config.tenant, "beta-caep");
    assert.equal(config.apiBase, "https://beta-caep.api.identitynow-demo.com");
    assert.equal(config.clientId, "caep-client");
    assert.equal(config.clientSecret, "caep-secret");
    assert.equal(config.passwordClientId, "caep-pw-client");
    assert.equal(config.passwordClientSecret, "caep-pw-secret");
    assert.equal(config.ownerId, "owner-1");
    assert.equal(config.notifyEmail, "owner@example.com");
  });

  it("falls back to the env settings when no profile is active", () => {
    process.env.SAF_TENANT = "beta-env";
    process.env.SAF_CLIENT_ID = "env-client";
    process.env.SAF_CLIENT_SECRET = "env-secret";
    const config = loadSafPocConfig();
    assert.equal(config.tenant, "beta-env");
    assert.equal(config.clientId, "env-client");
  });
});
