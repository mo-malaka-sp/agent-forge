import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { featureForRoute } from "@/lib/isc/route-features";

// Every route under src/app, including the CAEP endpoints outside /api.
const APP_DIR = path.resolve(import.meta.dirname, "../../src/app");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      routeFiles(full, out);
    } else if (entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

describe("route tenant coverage", () => {
  const files = routeFiles(APP_DIR);

  it("finds app routes", () => {
    assert.ok(files.length > 50, `expected many routes, found ${files.length}`);
  });

  for (const file of files) {
    const rel = path.relative(APP_DIR, file).replace(/\\/g, "/");

    it(`${rel} has an assigned feature and is wrapped with it`, () => {
      const feature = featureForRoute(rel);
      const source = fs.readFileSync(file, "utf8");

      if (feature === "none") {
        // Routes that never touch a tenant may export their handlers directly.
        return;
      }

      const unwrapped = METHODS.filter((method) =>
        new RegExp(`^export (async )?function ${method}\\b`, "m").test(source),
      );
      assert.deepEqual(unwrapped, [], `${rel} exports handlers without withFeatureTenant`);

      const exported = METHODS.filter((method) =>
        new RegExp(`^export const ${method} = withFeatureTenant\\(`, "m").test(source),
      );
      assert.ok(exported.length > 0, `${rel} (${feature}) has no wrapped handler`);

      if (feature === "section") {
        // Shared routes pick the tenant from ?section= on each request.
        assert.ok(
          source.includes("withFeatureTenant(sectionFeature"),
          `${rel} is shared by sections and must be wrapped with sectionFeature`,
        );
        return;
      }

      assert.ok(
        source.includes(`withFeatureTenant("${feature}"`),
        `${rel} is wrapped with the wrong feature, expected "${feature}"`,
      );
    });
  }
});
