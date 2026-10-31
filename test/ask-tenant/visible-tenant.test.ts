import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveVisibleTenant } from "@/lib/isc/visible-tenant";

describe("visible tenant", () => {
  it("uses the browser save when the server render has no tenant", () => {
    const visible = resolveVisibleTenant({
      serverConnected: false,
      serverTenant: null,
      sessionTenant: "company23069-poc",
      apiConfigured: false,
      apiTenant: null,
    });
    assert.deepEqual(visible, { connected: true, tenant: "company23069-poc" });
  });

  it("uses the credentials API when this browser has no save", () => {
    const visible = resolveVisibleTenant({
      serverConnected: false,
      serverTenant: null,
      sessionTenant: null,
      apiConfigured: true,
      apiTenant: "company23069-poc",
    });
    assert.deepEqual(visible, { connected: true, tenant: "company23069-poc" });
  });

  it("stays disconnected when nothing is saved", () => {
    const visible = resolveVisibleTenant({
      serverConnected: false,
      serverTenant: null,
      sessionTenant: null,
      apiConfigured: false,
      apiTenant: null,
    });
    assert.deepEqual(visible, { connected: false, tenant: null });
  });
});
