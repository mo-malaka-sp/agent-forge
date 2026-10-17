import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { credentialsMatch } from "@/lib/auth/credentials";
import { createSessionToken, readSession } from "@/lib/auth/session";

const previousUser = process.env.AGENTFORGE_ADMIN_USERNAME;
const previousPassword = process.env.AGENTFORGE_ADMIN_PASSWORD;

afterEach(() => {
  restore("AGENTFORGE_ADMIN_USERNAME", previousUser);
  restore("AGENTFORGE_ADMIN_PASSWORD", previousPassword);
});

describe("shared login", () => {
  it("accepts only the configured account", () => {
    delete process.env.AGENTFORGE_ADMIN_USERNAME;
    delete process.env.AGENTFORGE_ADMIN_PASSWORD;
    assert.equal(credentialsMatch("agentforge", "Forge-demo-17"), true);
    assert.equal(credentialsMatch("agentforge", "wrong123"), false);
    assert.equal(credentialsMatch("other.admin", "Forge-demo-17"), false);
  });

  it("expires a session token and rejects tampering", async () => {
    delete process.env.AGENTFORGE_ADMIN_USERNAME;
    delete process.env.AGENTFORGE_ADMIN_PASSWORD;
    const now = Date.parse("2026-10-17T12:00:00Z");
    const token = await createSessionToken("agentforge", now);
    assert.equal(await readSession(token, now + 1000), "agentforge");
    assert.equal(await readSession(token, now + 13 * 60 * 60 * 1000), null);
    const [payload] = token.split(".");
    assert.equal(await readSession(`${payload}.tampered`, now + 1000), null);
  });
});

function restore(name: "AGENTFORGE_ADMIN_USERNAME" | "AGENTFORGE_ADMIN_PASSWORD", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
