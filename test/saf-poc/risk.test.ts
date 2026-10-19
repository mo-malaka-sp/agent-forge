import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changeAgentRisk } from "@/lib/saf-poc/risk";

describe("agent risk changes", () => {
  it("rejects a real agent condition before sending CAEP", async () => {
    await assert.rejects(
      () =>
        changeAgentRisk({
          mode: "agent-condition",
          agentId: "agent-1",
          riskLevel: "High",
          publicUrl: "https://example.test",
        }),
      /No event was sent/,
    );
  });
});
