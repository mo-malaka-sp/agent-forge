import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProfileBodyError, parseBindingBody, parseProfileBody } from "@/lib/isc/profile-api";

describe("parseProfileBody", () => {
  it("accepts a tenant slug and keeps the domain blank when none is given", () => {
    const input = parseProfileBody({
      name: "Demo",
      tenant: "beta-26912",
      clientId: "id",
      clientSecret: "secret",
    });
    assert.equal(input.tenant, "beta-26912");
    assert.equal(input.domain, undefined);
  });

  it("splits a pasted tenant URL into tenant and domain", () => {
    const input = parseProfileBody({
      name: "Demo",
      tenant: "https://beta-26912.identitynow-demo.com/ui/d/mysailpoint",
      clientId: "id",
    });
    assert.equal(input.tenant, "beta-26912");
    assert.equal(input.domain, "identitynow-demo.com");
  });

  it("keeps an explicit allowed domain over the one in a pasted URL", () => {
    const input = parseProfileBody({
      name: "Demo",
      tenant: "https://beta-26912.identitynow.com/",
      domain: "identitynow-demo.com",
      clientId: "id",
    });
    assert.equal(input.domain, "identitynow-demo.com");
  });

  it("refuses an explicit domain outside the allowlist", () => {
    assert.throws(
      () =>
        parseProfileBody({
          name: "Demo",
          tenant: "beta-26912",
          domain: "example.com",
          clientId: "id",
        }),
      /tenant domain must be/,
    );
  });

  it("turns a blank secret into undefined so an edit keeps the stored one", () => {
    const input = parseProfileBody({ name: "Demo", tenant: "beta-1", clientId: "id", clientSecret: "  " });
    assert.equal(input.clientSecret, undefined);
  });

  it("names the missing required field", () => {
    assert.throws(
      () => parseProfileBody({ name: "Demo", tenant: "beta-1" }),
      (error: unknown) => error instanceof ProfileBodyError && /Client ID is required/.test(error.message),
    );
  });

  it("rejects a tenant URL it cannot read", () => {
    assert.throws(
      () => parseProfileBody({ name: "Demo", tenant: "https://localhost/", clientId: "id" }),
      /valid tenant URL/,
    );
  });
});

describe("parseBindingBody", () => {
  it("accepts a known feature and a null profile to clear it", () => {
    assert.deepEqual(parseBindingBody({ feature: "caep", profileId: null }), {
      feature: "caep",
      profileId: null,
    });
  });

  it("rejects an unknown feature", () => {
    assert.throws(() => parseBindingBody({ feature: "billing", profileId: "x" }), /Choose a feature/);
  });
});
