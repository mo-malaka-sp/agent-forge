import { iscRequest } from "@/lib/isc/client";
import { extractTaskId } from "@/lib/isc/tasks";
import type { AggregationStartResult, IscConfig } from "@/lib/isc/types";

function toAggregationResult(raw: unknown): AggregationStartResult {
  return {
    taskId: extractTaskId(raw),
    raw,
  };
}

export async function startEntitlementAggregation(
  config: IscConfig,
): Promise<AggregationStartResult> {
  const raw = await iscRequest(
    config,
    `/entitlements/aggregate/sources/${config.sourceId}`,
    { method: "POST", bodyMode: "none" },
  );

  return toAggregationResult(raw);
}

/** ISC API triggers the default "Group Aggregation" operation only (not typed ops). */
export async function startOutboundEntitlementAggregation(
  config: IscConfig,
): Promise<AggregationStartResult> {
  return startEntitlementAggregation(config);
}

export async function startDatasetAggregation(
  config: IscConfig,
  datasetId: string,
  options: { config?: Record<string, unknown> } = {},
): Promise<AggregationStartResult> {
  const normalizedDatasetId = datasetId.trim();
  if (!normalizedDatasetId) {
    throw new Error("Dataset aggregation requires a dataset ID.");
  }

  const raw = await iscRequest(
    config,
    `/sources/v1/${config.sourceId}/datasets/${encodeURIComponent(normalizedDatasetId)}/aggregate`,
    {
      method: "POST",
      apiVersion: null,
      experimental: true,
      // The body is optional, but the endpoint still refuses a request with no
      // Content-Type (RESTEASY003065), so always send JSON — `{}` when there is
      // no connector-specific config.
      body: options.config ? { config: options.config } : {},
    },
  );

  return toAggregationResult(raw);
}

export async function startAccountAggregation(
  config: IscConfig,
  options: { disableOptimization?: boolean } = {},
): Promise<AggregationStartResult> {
  if (options.disableOptimization) {
    const raw = await iscRequest(
      config,
      `/sources/${config.sourceId}/load-accounts`,
      {
        method: "POST",
        bodyMode: "form",
        body: { disableOptimization: "true" },
      },
    );

    return toAggregationResult(raw);
  }

  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/load-accounts`,
    { method: "POST", bodyMode: "none" },
  );

  return toAggregationResult(raw);
}
