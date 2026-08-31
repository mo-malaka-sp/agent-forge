import { getIscBaseUrl, getIscCredentials } from "@/lib/isc/config";
import { iscRequest } from "@/lib/isc/client";
import { getDatasetId, getIscSourceId } from "@/lib/isc/settings-store";
import {
  listSourceDatasets,
  listSourceResources,
  matchDataset,
} from "@/lib/isc/datasets";
import {
  describeMissingResourceOperations,
  findMissingResourceOperations,
  readSourceOperations,
} from "@/lib/isc/source-operations";
import { DEPLOYMENT_PROVIDERS, type DeploymentProvider } from "@/lib/providers/profiles";

export interface IscSourceVerifyResult {
  provider: DeploymentProvider;
  sourceId: string;
  ok: boolean;
  sourceName: string | null;
  message: string;
  datasetId?: string | null;
  datasetFound?: boolean;
  /** Base URL the ISC source calls back on (Web Services connector attribute). */
  connectorBaseUrl?: string | null;
  /** Public URL of this AgentForge deployment, when the caller could resolve it. */
  expectedBaseUrl?: string | null;
  baseUrlMatches?: boolean;
  /** Agent resource names ISC reports for this source. */
  resourceNames?: string[];
  /** `Resource Aggregation-*` operations configured on the Web Services source. */
  resourceAggregationOperations?: string[];
  /** False when no operation matches a resource, which fails dataset aggregation. */
  resourceOperationsMatch?: boolean;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/$/, "");
}

export async function verifyIscPlatformSource(
  provider: DeploymentProvider,
  sourceIdInput?: string,
  expectedBaseUrl?: string,
): Promise<IscSourceVerifyResult> {
  const credentials = getIscCredentials();
  if (!credentials) {
    return {
      provider,
      sourceId: sourceIdInput?.trim() ?? "",
      ok: false,
      sourceName: null,
      message:
        "ISC credentials are not configured. Save tenant connection above first.",
    };
  }

  const sourceId = sourceIdInput?.trim() || getIscSourceId(provider) || "";
  if (!sourceId) {
    return {
      provider,
      sourceId: "",
      ok: false,
      sourceName: null,
      message: `No source ID saved for ${DEPLOYMENT_PROVIDERS[provider].label}.`,
    };
  }

  try {
    const source = await iscRequest<{
      id?: string;
      name?: string;
      connectorAttributes?: { genericWebServiceBaseUrl?: string };
    }>({ ...credentials, sourceId }, `/sources/${sourceId}`);

    const name = source.name?.trim() ?? null;
    const connectorBaseUrl =
      source.connectorAttributes?.genericWebServiceBaseUrl?.trim() || null;
    const expected = expectedBaseUrl?.trim() || null;
    const baseUrlMatches =
      expected && connectorBaseUrl
        ? normalizeUrl(connectorBaseUrl) === normalizeUrl(expected)
        : undefined;

    let baseUrlMessage = "";
    if (connectorBaseUrl && baseUrlMatches === false) {
      baseUrlMessage = ` Base URL on the source is ${connectorBaseUrl}, but this deployment is ${expected} — ISC cannot reach AgentForge until it is repaired.`;
    } else if (connectorBaseUrl && baseUrlMatches === true) {
      baseUrlMessage = ` Base URL ${connectorBaseUrl} matches this deployment.`;
    } else if (connectorBaseUrl) {
      baseUrlMessage = ` Base URL on the source is ${connectorBaseUrl}.`;
    }

    const preferredDatasetId = getDatasetId(provider);
    let datasetFound = false;
    let datasetMessage = "";
    try {
      const datasets = await listSourceDatasets({ ...credentials, sourceId });
      datasetFound = Boolean(matchDataset(datasets, preferredDatasetId));
      datasetMessage = datasetFound
        ? ` Dataset “${preferredDatasetId}” is present.`
        : ` Dataset “${preferredDatasetId}” was not listed — create it under Dataset Management or run full sync (AgentForge will POST /datasets).`;
    } catch {
      datasetMessage =
        " Could not list datasets (endpoint may still be experimental).";
    }

    const operations = await readSourceOperations({
      ...credentials,
      sourceId,
    }).catch(() => null);
    const resourceAggregationOperations =
      operations?.resourceAggregationOperations ?? [];

    let resourceNames: string[] = [];
    let resourceOperationsMatch: boolean | undefined;
    let resourceMessage = "";
    try {
      const resources = await listSourceResources({ ...credentials, sourceId });
      resourceNames = resources.map((resource) => resource.name);

      if (resourceNames.length > 0 && operations) {
        const missing = findMissingResourceOperations(operations, resourceNames);
        resourceOperationsMatch = missing.length === 0;
        resourceMessage = resourceOperationsMatch
          ? ` Resource aggregation operations match resource(s) ${resourceNames.join(", ")}.`
          : ` ${describeMissingResourceOperations(operations, missing)}`;
      }
    } catch {
      resourceMessage = " Could not list resources to check operation mapping.";
    }

    return {
      provider,
      sourceId,
      ok: baseUrlMatches !== false && resourceOperationsMatch !== false,
      sourceName: name,
      datasetId: preferredDatasetId,
      datasetFound,
      connectorBaseUrl,
      expectedBaseUrl: expected,
      baseUrlMatches,
      resourceNames,
      resourceAggregationOperations,
      resourceOperationsMatch,
      message: `${
        name
          ? `Verified source “${name}” (${sourceId})`
          : `Verified source ${sourceId}`
      }.${baseUrlMessage}${datasetMessage}${resourceMessage}`,
    };
  } catch (error) {
    const raw =
      error instanceof Error
        ? error.message
        : "Could not verify source with ISC API";
    const apiBase = getIscBaseUrl(credentials);
    const tenantHint =
      raw.includes("404") || raw.includes("Not found")
        ? ` API base: ${apiBase}. If this tenant is wrong, re-save ISC tenant connection above (UI overrides baked Amplify env vars when saved).`
        : "";

    return {
      provider,
      sourceId,
      ok: false,
      sourceName: null,
      message: `${raw}${tenantHint}`,
    };
  }
}
