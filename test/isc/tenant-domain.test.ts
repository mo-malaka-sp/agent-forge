import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { checkIscConnection } from "@/lib/isc/connection-check";
import { parseProfileBody, ProfileBodyError } from "@/lib/isc/profile-api";
import {
  getProfile,
  profileRuntime,
  saveProfile,
  type IscProfile,
} from "@/lib/isc/profiles-store";
import { iscHostProblem, isAllowedIscDomain } from "@/lib/isc/tenant-url";
import { createFileStore, type SafPocStore } from "@/lib/saf-poc/storage";

let dir: string;
let store: SafPocStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-domain-"));
  store = createFileStore(path.join(dir, "state.json"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const form = { name: "Acme", clientId: "client", clientSecret: "secret" };

describe("tenant domain allowlist", () => {
  it("allows the SailPoint identitynow domains only", () => {
    assert.equal(isAllowedIscDomain("identitynow.com"), true);
    assert.equal(isAllowedIscDomain("IdentityNow-Demo.com"), true);
    assert.equal(isAllowedIscDomain("evil.example.com"), false);
    assert.equal(isAllowedIscDomain("identitynow.com.evil.example"), false);
    assert.equal(iscHostProblem("acme", "identitynow.com"), null);
    assert.match(iscHostProblem("acme", "example.com") ?? "", /must be identitynow.com or identitynow-demo.com/);
  });

  it("rejects tenant names that are not a single DNS label", () => {
    assert.match(iscHostProblem("acme.evil", "identitynow.com") ?? "", /tenant name/);
    assert.match(iscHostProblem("ac me", "identitynow.com") ?? "", /tenant name/);
  });

  it("refuses a pasted URL on another domain", () => {
    assert.throws(
      () => parseProfileBody({ ...form, tenant: "https://acme.example.com/" }),
      (error: unknown) => error instanceof ProfileBodyError && /tenant domain/.test(error.message),
    );
  });

  it("accepts a pasted URL on an allowed domain", () => {
    const parsed = parseProfileBody({ ...form, tenant: "https://acme.identitynow-demo.com/" });
    assert.equal(parsed.tenant, "acme");
    assert.equal(parsed.domain, "identitynow-demo.com");
  });

  it("refuses to save a profile on another domain", async () => {
    await assert.rejects(
      saveProfile({ ...form, tenant: "acme", domain: "example.com" }, { store }),
      /tenant domain must be/,
    );
    assert.deepEqual((await store.list("ISC_PROFILE#")).length, 0);
  });

  it("refuses to build a runtime that would send the secret to another host", async () => {
    const saved = await saveProfile({ ...form, tenant: "acme", domain: "identitynow.com" }, { store });
    const profile = (await getProfile(saved.id, store)) as IscProfile;
    assert.doesNotThrow(() => profileRuntime(profile));
    assert.throws(
      () => profileRuntime({ ...profile, domain: "example.com" }),
      /tenant domain must be/,
    );
  });

  it("does not send any request for a tenant on another domain", async () => {
    const calls: string[] = [];
    const result = await checkIscConnection(
      { tenant: "acme", domain: "example.com", clientId: "client", clientSecret: "secret" },
      async (url) => {
        calls.push(String(url));
        return new Response("{}", { status: 200 });
      },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
    assert.equal(result.steps[0]?.id, "domain");
  });
});
