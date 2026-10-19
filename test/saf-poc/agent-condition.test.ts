import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  caepBandChange,
  ownerRemovalPatch,
  ownerRestorePatch,
  ownerPatchFromRecord,
  workerAuthorized,
} from "@/lib/saf-poc/agent-condition";
import { riskLevelsFromSchema } from "@/lib/saf-poc/sailpoint";

describe("real agent condition safety", () => {
  it("only selects recognized live owner shapes", () => {
    assert.deepEqual(
      ownerPatchFromRecord({
        owners: { primaryIdentity: { id: "owner-1", type: "IDENTITY" } },
      }),
      {
        path: "/owners/primaryIdentity",
        value: { id: "owner-1", type: "IDENTITY" },
      },
    );
    assert.deepEqual(
      ownerPatchFromRecord({ primaryIdentity: { id: "owner-2" } }),
      { path: "/primaryIdentity", value: { id: "owner-2" } },
    );
    assert.equal(ownerPatchFromRecord({ ownerConfigId: "owner-1" }), null);
  });

  it("never sends CAEP for an unchanged or unsupported band", () => {
    assert.equal(caepBandChange("Medium", "Medium", []), "unchanged");
    assert.equal(
      caepBandChange("High", "Critical", ["LOW", "MEDIUM", "HIGH"]),
      "unsupported",
    );
    assert.equal(
      caepBandChange("Medium", "High", ["LOW", "MEDIUM", "HIGH"]),
      "send",
    );
  });

  it("pairs every owner removal with an exact restoration patch", () => {
    const run = {
      ownerPath: "/owners/primaryIdentity",
      ownerId: "owner-1",
      ownerValue: { id: "owner-1", type: "IDENTITY" },
    };
    assert.deepEqual(ownerRemovalPatch(run), [
      { op: "test", path: "/owners/primaryIdentity/id", value: "owner-1" },
      { op: "remove", path: "/owners/primaryIdentity" },
    ]);
    assert.deepEqual(ownerRestorePatch(run), [
      {
        op: "add",
        path: "/owners/primaryIdentity",
        value: { id: "owner-1", type: "IDENTITY" },
      },
    ]);
  });

  it("reads supported levels from the trigger schema", () => {
    assert.deepEqual(
      riskLevelsFromSchema({
        properties: {
          current_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
        },
      }),
      ["LOW", "MEDIUM", "HIGH"],
    );
  });

  it("requires the exact worker token", () => {
    const previous = process.env.SAF_POC_WORKER_TOKEN;
    process.env.SAF_POC_WORKER_TOKEN = "worker-secret";
    try {
      assert.equal(workerAuthorized("worker-secret"), true);
      assert.equal(workerAuthorized("wrong"), false);
      assert.equal(workerAuthorized(null), false);
    } finally {
      if (previous === undefined) delete process.env.SAF_POC_WORKER_TOKEN;
      else process.env.SAF_POC_WORKER_TOKEN = previous;
    }
  });
});
