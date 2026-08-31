import { getIscBaseUrl, getIscCredentials } from "@/lib/isc/config";
import { iscRequest } from "@/lib/isc/client";
import { getDatasetId, getIscSourceId } from "@/lib/isc/settings-store";
import { listSourceDatasets, matchDataset } from "@/lib/isc/datasets";
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

    return {
      provider,
      sourceId,
      ok: baseUrlMatches !== false,
      sourceName: name,
      datasetId: preferredDatasetId,
      datasetFound,
      connectorBaseUrl,
      expectedBaseUrl: expected,
      baseUrlMatches,
      message: `${
        name
          ? `Verified source “${name}” (${sourceId})`
          : `Verified source ${sourceId}`
      }.${baseUrlMessage}${datasetMessage}`,
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
