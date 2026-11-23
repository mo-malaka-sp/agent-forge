import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sectionFeature } from "@/lib/saf-poc/section";

describe("SAF POC section tenant", () => {
  it("picks the tenant feature of the section in ?section=", () => {
    assert.equal(sectionFeature(new Request("http://x/api/saf-poc/state?section=caep")), "caep");
    assert.equal(
      sectionFeature(new Request("http://x/api/saf-poc/simulate?section=endpoint")),
      "endpoint",
    );
    assert.equal(
      sectionFeature(new Request("http://x/api/saf-poc/reset?section=datadog")),
      "datadog",
    );
  });

  it("falls back to Datadog without a valid section", () => {
    assert.equal(sectionFeature(new Request("http://x/api/saf-poc/state")), "datadog");
    assert.equal(
      sectionFeature(new Request("http://x/api/saf-poc/state?section=unknown")),
      "datadog",
    );
    assert.equal(sectionFeature(), "datadog");
  });
});
