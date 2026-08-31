import { iscRequest } from "@/lib/isc/client";
import type { IscConfig } from "@/lib/isc/config";

/**
 * Web Services SaaS operation mapping.
 *
 * The connector matches a dataset's resources to HTTP endpoints by operation
 * type. A resource named `bedrock-agent` is only aggregated by an operation
 * typed `Resource Aggregation-bedrock-agent`; the retired
 * `Machine Identity Aggregation-{name}` type matches nothing and fails the
 * aggregation task with "No resource aggregation endpoints matched dataset".
 */

const RESOURCE_AGGREGATION_PREFIX = "Resource Aggregation-";

export interface SourceOperations {
  sourceId: string;
  sourceName: string | null;
  /** Every operation type configured on the source. */
  operationTypes: string[];
  /** Just the `Resource Aggregation-*` operation types. */
  resourceAggregationOperations: string[];
  /** Retired `Machine Identity Aggregation-*` operations, if any remain. */
  retiredMachineIdentityOperations: string[];
}

export function resourceAggregationOperationType(resourceName: string): string {
  return `${RESOURCE_AGGREGATION_PREFIX}${resourceName.trim()}`;
}

export async function readSourceOperations(
  config: IscConfig,
): Promise<SourceOperations> {
  const source = await iscRequest<{
    name?: string;
    connectorAttributes?: {
      connectionParameters?: Array<{ operationType?: string }>;
    };
  }>(config, `/sources/${config.sourceId}`);

  const operationTypes = (
    source.connectorAttributes?.connectionParameters ?? []
  )
    .map((parameter) => parameter?.operationType?.trim() ?? "")
    .filter((operationType) => operationType.length > 0);

  return {
    sourceId: config.sourceId,
    sourceName: source.name?.trim() ?? null,
    operationTypes,
    resourceAggregationOperations: operationTypes.filter((operationType) =>
      operationType.startsWith(RESOURCE_AGGREGATION_PREFIX),
    ),
    retiredMachineIdentityOperations: operationTypes.filter((operationType) =>
      operationType.startsWith("Machine Identity Aggregation-"),
    ),
  };
}

export function findMissingResourceOperations(
  operations: SourceOperations,
  resourceNames: string[],
): string[] {
  return resourceNames.filter(
    (resourceName) =>
      !operations.resourceAggregationOperations.includes(
        resourceAggregationOperationType(resourceName),
      ),
  );
}

/**
 * Explains a mapping gap in terms of the source it was found on — the source
 * name matters because a source ID saved against the wrong platform presents
 * exactly as a missing operation.
 */
export function describeMissingResourceOperations(
  operations: SourceOperations,
  missing: string[],
): string {
  const sourceLabel = operations.sourceName
    ? `“${operations.sourceName}” (${operations.sourceId})`
    : operations.sourceId;

  const expected = missing
    .map((resourceName) => `“${resourceAggregationOperationType(resourceName)}”`)
    .join(", ");

  const found =
    operations.resourceAggregationOperations.length > 0
      ? `found ${operations.resourceAggregationOperations.join(", ")}`
      : operations.retiredMachineIdentityOperations.length > 0
        ? `the source still uses the retired ${operations.retiredMachineIdentityOperations.join(", ")}`
        : "the source has no resource aggregation operation at all";

  return `Source ${sourceLabel} is missing ${expected} — ${found}. Re-import the current golden package for this platform, and confirm this source ID belongs to the platform you are running.`;
}
