import type { TenantFeature } from "@/lib/isc/feature-tenant";

/** The SAF POC sections in the UI, and the tenant feature each one uses. */
export const SAF_SECTION_FEATURES = {
  caep: "caep",
  datadog: "datadog",
  endpoint: "endpoint",
} as const satisfies Record<string, TenantFeature>;

export type SafSection = keyof typeof SAF_SECTION_FEATURES;

/**
 * The tenant feature for a request from one section, read from `?section=`. Shared routes
 * (state, simulate, reset, demo-stream) use this, so an event is stamped with the tenant of
 * the section that created it. Without a valid section, Datadog is used.
 */
export function sectionFeature(...args: unknown[]): TenantFeature {
  const request = args.find((arg): arg is Request => arg instanceof Request);
  const section = request ? new URL(request.url).searchParams.get("section") : null;
  if (section && section in SAF_SECTION_FEATURES) {
    return SAF_SECTION_FEATURES[section as SafSection];
  }
  return "datadog";
}
