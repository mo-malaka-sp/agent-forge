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
}

export async function verifyIscPlatformSource(
  provider: DeploymentProvider,
  sourceIdInput?: string,
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
    const source = await iscRequest<{ id?: string; name?: string }>(
      { ...credentials, sourceId },
      `/sources/${sourceId}`,
    );

    const name = source.name?.trim() ?? null;
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
      ok: true,
      sourceName: name,
      datasetId: preferredDatasetId,
      datasetFound,
      message: `${
        name
          ? `Verified source “${name}” (${sourceId})`
          : `Verified source ${sourceId}`
      }.${datasetMessage}`,
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
