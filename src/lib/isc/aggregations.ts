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

export async function startMachineIdentityAggregation(
  config: IscConfig,
  datasetIds: string[] = ["bedrock-agent"],
  options: { disableOptimization?: boolean } = {},
): Promise<AggregationStartResult> {
  if (datasetIds.length === 0) {
    throw new Error(
      "Dataset aggregation requires at least one datasetId (e.g. bedrock-agent).",
    );
  }

  const body: { datasetIds: string[]; disableOptimization?: boolean } = {
    datasetIds,
  };
  if (options.disableOptimization) {
    body.disableOptimization = true;
  }

  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/aggregate-agents`,
    {
      method: "POST",
      body,
      experimental: true,
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
