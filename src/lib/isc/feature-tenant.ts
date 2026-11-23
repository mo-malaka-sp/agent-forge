import type { SafPocStore } from "@/lib/saf-poc/storage";
import {
  ensureLegacyTenantsMigrated,
  profileForFeature,
  profileRuntime,
  TENANT_FEATURES,
  type TenantFeature,
} from "@/lib/isc/profiles-store";
import {
  runWithIscRuntimeAsync,
  type IscRuntimePayload,
} from "@/lib/isc/runtime-config";

export { TENANT_FEATURES, type TenantFeature };

const CACHE_MS = 30_000;

type CachedRuntime = { at: number; runtime: IscRuntimePayload | undefined };
const runtimeCache = new Map<TenantFeature, CachedRuntime>();

/** Forget cached tenant lookups. Call after a profile or binding changes on this instance. */
export function clearFeatureTenantCache(): void {
  runtimeCache.clear();
}

/**
 * The tenant a feature should use right now: its binding, else the default binding.
 * Returns undefined when nothing is saved, and callers then fall back to the env settings.
 */
export async function resolveFeatureRuntime(
  feature: TenantFeature,
  store?: SafPocStore,
): Promise<IscRuntimePayload | undefined> {
  const cached = runtimeCache.get(feature);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.runtime;
  }
  await ensureLegacyTenantsMigrated(store);
  const profile = await profileForFeature(feature, store);
  const runtime = profile ? profileRuntime(profile) : undefined;
  runtimeCache.set(feature, { at: Date.now(), runtime });
  return runtime;
}

/**
 * Wraps a route handler so it runs against the tenant bound to `feature`.
 * `feature` may be a function of the request, for routes shared by several sections.
 * The browser cannot override this. A lookup failure throws; it never falls back to another
 * tenant.
 */
export function withFeatureTenant<A extends unknown[], R>(
  feature: TenantFeature | ((...args: A) => TenantFeature),
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const chosen = typeof feature === "function" ? feature(...args) : feature;
    const runtime = await resolveFeatureRuntime(chosen);
    return runWithIscRuntimeAsync(runtime, () => handler(...args));
  };
}
