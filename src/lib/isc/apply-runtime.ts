import type { IscRuntimePayload } from "@/lib/isc/runtime-config";

/**
 * Kept so existing route handlers keep compiling. A request-supplied ISC connection no longer
 * overrides the tenant: each route's feature binding decides it (see `withFeatureTenant`).
 */
export async function withRequestIscRuntime<T>(
  _request: Request,
  _body: { isc_runtime?: IscRuntimePayload } | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}
