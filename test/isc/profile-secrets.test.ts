import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import {
  createSecretsManagerVault,
  profileSecretName,
  setProfileSecretVaultForTests,
  type ProfileSecretVault,
} from "@/lib/isc/profile-secrets";
import {
  deleteProfile,
  getProfile,
  saveProfile,
  setBinding,
  toPublicProfile,
  updateProfileSources,
  recordProfileTest,
} from "@/lib/isc/profiles-store";
import { createFileStore, type SafPocStore } from "@/lib/saf-poc/storage";

let dir: string;
let store: SafPocStore;

/** In-memory vault that counts writes, so tests can prove when the vault was touched. */
function memoryVault() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const vault: ProfileSecretVault = {
    async put(name, value) {
      writes.push(name);
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    async delete(name) {
      values.delete(name);
    },
  };
  return { vault, values, writes };
}

const input = {
  name: "Acme",
  tenant: "acme",
  domain: "identitynow.com",
  clientId: "client-1",
  clientSecret: "s3cr3t-value",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-secrets-"));
  store = createFileStore(path.join(dir, "state.json"));
});

afterEach(() => {
  setProfileSecretVaultForTests(undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("profile client secrets", () => {
  it("keeps the secret out of the stored record and the public view", async () => {
    const { vault, values } = memoryVault();
    setProfileSecretVaultForTests(vault);

    const saved = await saveProfile(input, { store });
    const raw = await store.get<Record<string, unknown>>(`ISC_PROFILE#${saved.id}`);

    assert.ok(raw);
    assert.equal(JSON.stringify(raw).includes("s3cr3t-value"), false);
    assert.equal(raw.clientSecret, undefined);
    assert.equal(raw.clientSecretRef, profileSecretName(saved.id, "client"));
    assert.equal(values.get(profileSecretName(saved.id, "client")), "s3cr3t-value");

    assert.equal(JSON.stringify(saved).includes("s3cr3t-value"), false);
    assert.equal(saved.clientSecretSet, true);
    assert.equal((await getProfile(saved.id, store))?.clientSecret, "s3cr3t-value");
  });

  it("does not write to the vault when an edit leaves the secret alone", async () => {
    const { vault, writes } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });
    assert.equal(writes.length, 1);

    await saveProfile({ ...input, name: "Renamed", clientSecret: "" }, { id: saved.id, store });

    assert.equal(writes.length, 1);
    assert.equal((await getProfile(saved.id, store))?.clientSecret, "s3cr3t-value");
    assert.equal((await getProfile(saved.id, store))?.name, "Renamed");
  });

  it("replaces the stored secret when a new one is entered", async () => {
    const { vault, values } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });

    await saveProfile({ ...input, clientSecret: "rotated" }, { id: saved.id, store });

    assert.equal(values.get(profileSecretName(saved.id, "client")), "rotated");
    assert.equal((await getProfile(saved.id, store))?.clientSecret, "rotated");
  });

  it("keeps the reference through source edits and test results", async () => {
    const { vault, writes } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });
    const before = writes.length;

    const updated = await updateProfileSources(saved.id, { aws_bedrock: "src-1" }, store);
    await recordProfileTest(saved.id, { ok: true, summary: "fine" }, store);

    assert.equal(writes.length, before);
    assert.equal(updated.clientSecretSet, true);
    const raw = await store.get<Record<string, unknown>>(`ISC_PROFILE#${saved.id}`);
    assert.equal(raw?.clientSecretRef, profileSecretName(saved.id, "client"));
    assert.equal(JSON.stringify(raw).includes("s3cr3t-value"), false);
  });

  it("removes the secrets from the vault when a tenant is deleted", async () => {
    const { vault, values } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });
    assert.equal(values.size, 1);

    // The first tenant is the default. Unbind it, as the Tenants page does, before deleting.
    await setBinding("default", null, store);
    await deleteProfile(saved.id, store);

    assert.equal(values.size, 0);
    assert.equal(await getProfile(saved.id, store), null);
  });

  it("reads a missing secret as not set, so the tenant can be edited", async () => {
    const { vault, values } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });
    values.clear();

    const profile = await getProfile(saved.id, store);
    assert.equal(profile?.clientSecret, "");
    assert.equal(toPublicProfile(profile!).clientSecretSet, false);
  });

  it("refuses to read a secret reference when no vault is configured", async () => {
    const { vault } = memoryVault();
    setProfileSecretVaultForTests(vault);
    const saved = await saveProfile(input, { store });

    setProfileSecretVaultForTests(null);
    await assert.rejects(getProfile(saved.id, store), /Secrets Manager/);
  });

  it("keeps the secret in the local record when no vault is configured (development)", async () => {
    setProfileSecretVaultForTests(null);
    const saved = await saveProfile(input, { store });
    const raw = await store.get<Record<string, unknown>>(`ISC_PROFILE#${saved.id}`);

    assert.equal(raw?.clientSecret, "s3cr3t-value");
    assert.equal(raw?.clientSecretRef, undefined);
    assert.equal((await getProfile(saved.id, store))?.clientSecret, "s3cr3t-value");
  });
});

describe("Secrets Manager adapter", () => {
  /** Fake client that answers the same commands the real service would, with the same errors. */
  function fakeSecretsManager() {
    const secrets = new Map<string, string>();
    const notFound = () => Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
    const client = {
      async send(command: unknown) {
        if (command instanceof PutSecretValueCommand) {
          const name = command.input.SecretId ?? "";
          if (!secrets.has(name)) throw notFound();
          secrets.set(name, command.input.SecretString ?? "");
          return {};
        }
        if (command instanceof CreateSecretCommand) {
          secrets.set(command.input.Name ?? "", command.input.SecretString ?? "");
          return {};
        }
        if (command instanceof GetSecretValueCommand) {
          const name = command.input.SecretId ?? "";
          if (!secrets.has(name)) throw notFound();
          return { SecretString: secrets.get(name) };
        }
        if (command instanceof DeleteSecretCommand) {
          const name = command.input.SecretId ?? "";
          if (!secrets.has(name)) throw notFound();
          secrets.delete(name);
          return {};
        }
        throw new Error("unexpected command");
      },
    };
    return { secrets, client: client as unknown as SecretsManagerClient };
  }

  it("creates a secret on first put and overwrites it afterwards", async () => {
    const fake = fakeSecretsManager();
    const vault = createSecretsManagerVault(fake.client);

    await vault.put("agentforge/isc-profile/p1/client", "one");
    await vault.put("agentforge/isc-profile/p1/client", "two");

    assert.equal(fake.secrets.get("agentforge/isc-profile/p1/client"), "two");
    assert.equal(await vault.get("agentforge/isc-profile/p1/client"), "two");
  });

  it("reads a missing secret as null and deletes a missing secret quietly", async () => {
    const fake = fakeSecretsManager();
    const vault = createSecretsManagerVault(fake.client);

    assert.equal(await vault.get("agentforge/isc-profile/nope/client"), null);
    await vault.delete("agentforge/isc-profile/nope/client");
  });

  it("rethrows errors other than not found", async () => {
    const vault = createSecretsManagerVault({
      send: async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    } as unknown as SecretsManagerClient);

    await assert.rejects(vault.get("agentforge/isc-profile/p1/client"), /denied/);
  });
});
