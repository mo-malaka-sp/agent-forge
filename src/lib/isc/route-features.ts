/**
 * Which saved tenant each route uses. Paths are relative to `src/app`, without `/route.ts`;
 * the `api/` prefix is optional, so `api/saf-poc/state` and `saf-poc/state` match the same rule.
 * Rules are checked in order, so keep the more specific rules first.
 *
 * "none" means the route never reads a SailPoint tenant. Management routes for tenants
 * themselves are in this group.
 *
 * Used by: `test/isc/route-tenant-coverage.test.ts` (fails if a route is not wrapped) and
 * the one-time wrap script. Keep it in sync with `withFeatureTenant` wrappers in each route.
 */
export type RouteFeature =
  | "default"
  | "test-drive"
  | "caep"
  | "datadog"
  | "endpoint"
  | "ask"
  | "govern"
  | "section"
  | "none";

/**
 * "section" means the route is shared by the SAF POC sections, and the tenant comes from
 * `?section=` on the request (see `src/lib/saf-poc/section.ts`).
 */
const RULES: Array<{ prefix: string; feature: RouteFeature }> = [
  // Management of tenants themselves never uses a tenant.
  { prefix: "isc/profiles", feature: "none" },
  { prefix: "isc/bindings", feature: "none" },
  { prefix: "isc/credentials", feature: "none" },

  // SAF POC: endpoint risk.
  { prefix: "saf-poc/agent-condition/", feature: "endpoint" },
  { prefix: "saf-poc/risk", feature: "endpoint" },
  { prefix: "saf-poc/agents", feature: "endpoint" },

  // SAF POC: CAEP event bus.
  { prefix: "saf-poc/transmit", feature: "caep" },
  { prefix: "saf-poc/token", feature: "caep" },
  { prefix: "saf-poc/triggers", feature: "caep" },
  { prefix: "saf-poc/setup-test1", feature: "caep" },
  { prefix: "saf-poc/setup-test2", feature: "caep" },

  // SAF POC: shared feed. The section that made the request decides the tenant.
  { prefix: "saf-poc/simulate", feature: "section" },
  { prefix: "saf-poc/demo-stream", feature: "section" },
  { prefix: "saf-poc/reset", feature: "section" },
  { prefix: "saf-poc/state", feature: "section" },

  // CAEP transmitter endpoints outside /api: the SailPoint webhook, SSF API, signing key, and
  // the well-known configuration documents.
  { prefix: "webhooks/saf", feature: "caep" },
  { prefix: "ssf", feature: "caep" },
  { prefix: "jwks", feature: "caep" },
  { prefix: ".well-known", feature: "caep" },

  { prefix: "readonly-account", feature: "test-drive" },
  { prefix: "ask-tenant", feature: "ask" },

  // No tenant: auth, health, and the Asana and Slack POC tracker.
  { prefix: "auth", feature: "none" },
  { prefix: "health", feature: "none" },
  { prefix: "poc-tracker", feature: "none" },

  // Everything else that talks to SailPoint belongs to Govern and environments.
  { prefix: "agents", feature: "govern" },
  { prefix: "connectors", feature: "govern" },
  { prefix: "demo", feature: "govern" },
  { prefix: "environments", feature: "govern" },
  { prefix: "isc", feature: "govern" },
  { prefix: "setup", feature: "govern" },
];

export function featureForRoute(routePath: string): RouteFeature {
  const normalized = routePath
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/route\.ts$/, "")
    .replace(/^api\//, "");
  const rule = RULES.find((candidate) => normalized.startsWith(candidate.prefix));
  if (!rule) {
    throw new Error(`No tenant feature is assigned to route "${routePath}".`);
  }
  return rule.feature;
}
