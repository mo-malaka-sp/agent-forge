import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);

// Tests must not read or write a developer's local ./data files (saved ISC connection, tenants).
if (!process.env.AGENT_STORE_DIR) {
  process.env.AGENT_STORE_DIR = mkdtempSync(path.join(tmpdir(), "agent-forge-test-"));
}
