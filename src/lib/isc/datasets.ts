import { iscRequest } from "@/lib/isc/client";
import type { IscConfig } from "@/lib/isc/config";

/**
 * ISC Dataset / Resource APIs (v2026 Sources).
 *
 * Documented in the Python/Go SDKs and ISC Postman collection:
 * - GET  /sources/{sourceId}/datasets
 * - GET  /sources/{sourceId}/datasets/{datasetId}
 * - POST /sources/{sourceId}/datasets          (create; experimental)
 * - GET  /sources/{sourceId}/resources
 * - GET  /sources/{sourceId}/resources/{resourceId}
 * - POST /sources/{sourceId}/schemas           (create resource schema)
 * Aggregation of agent resources still uses:
 * - POST /sources/{sourceId}/aggregate-agents  { datasetIds, disableOptimization? }
 *
 * Web Services HTTP operationType remains
 * `Machine Identity Aggregation-{resourceName}` and maps to AgentForge /accounts.
 */

export const AGENT_RESOURCE_TYPE = "std:agent";

export interface SourceDataset {
  id: string;
  name: string;
  description?: string;
  aggregationEnabled?: boolean;
  resources?: Array<{ id?: string; name?: string }>;
  raw: Record<string, unknown>;
}

export interface SourceDatasetResource {
  id: string;
  name: string;
  type?: string;
  features?: string[];
  raw: Record<string, unknown>;
}

export interface EnsureAgentDatasetResult {
  dataset: SourceDataset;
  createdDataset: boolean;
  createdResource: boolean;
}

export interface AgentDatasetSpec {
  datasetId: string;
  displayName?: string;
  description?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const record = asRecord(payload);
  if (record && Array.isArray(record.items)) {
    return record.items;
  }
  return [];
}

function parseDataset(value: unknown): SourceDataset | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id && !name) {
    return null;
  }
  return {
    id: id || name,
    name: name || id,
    description:
      typeof record.description === "string" ? record.description : undefined,
    aggregationEnabled:
      typeof record.aggregationEnabled === "boolean"
        ? record.aggregationEnabled
        : undefined,
    resources: Array.isArray(record.resources)
      ? record.resources.map((item) => {
          const inner = asRecord(item);
          return {
            id: typeof inner?.id === "string" ? inner.id : undefined,
            name: typeof inner?.name === "string" ? inner.name : undefined,
          };
        })
      : undefined,
    raw: record,
  };
}

function parseResource(value: unknown): SourceDatasetResource | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!id && !name) {
    return null;
  }
  return {
    id: id || name,
    name: name || id,
    type: typeof record.type === "string" ? record.type : undefined,
    features: Array.isArray(record.features)
      ? record.features.filter((item): item is string => typeof item === "string")
      : undefined,
    raw: record,
  };
}

function datasetRequestOptions(accessToken?: string) {
  return {
    experimental: true,
    ...(accessToken ? { accessToken } : {}),
  } as const;
}

export async function listSourceDatasets(
  config: IscConfig,
  accessToken?: string,
): Promise<SourceDataset[]> {
  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/datasets`,
    datasetRequestOptions(accessToken),
  );
  return unwrapList(raw)
    .map(parseDataset)
    .filter((item): item is SourceDataset => item !== null);
}

export async function getSourceDataset(
  config: IscConfig,
  datasetId: string,
  accessToken?: string,
): Promise<SourceDataset | null> {
  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/datasets/${encodeURIComponent(datasetId)}`,
    datasetRequestOptions(accessToken),
  );
  return parseDataset(raw);
}

export async function createSourceDataset(
  config: IscConfig,
  input: {
    name: string;
    description?: string;
    aggregationEnabled?: boolean;
    id?: string;
  },
  accessToken?: string,
): Promise<SourceDataset> {
  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description ?? "",
    aggregationEnabled: input.aggregationEnabled ?? true,
  };
  if (input.id?.trim()) {
    body.id = input.id.trim();
  }

  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/datasets`,
    {
      method: "POST",
      body,
      ...datasetRequestOptions(accessToken),
    },
  );
  const parsed = parseDataset(raw);
  if (!parsed) {
    throw new Error("ISC create dataset did not return a dataset id.");
  }
  return parsed;
}

export async function listSourceSchemas(
  config: IscConfig,
  accessToken?: string,
): Promise<Array<{ id?: string; name?: string; configuration?: Record<string, unknown> }>> {
  const raw = await iscRequest(config, `/sources/${config.sourceId}/schemas`, {
    ...(accessToken ? { accessToken } : {}),
  });
  return unwrapList(raw)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      configuration: asRecord(item.configuration) ?? undefined,
    }));
}

export async function listSourceResources(
  config: IscConfig,
  accessToken?: string,
): Promise<SourceDatasetResource[]> {
  const raw = await iscRequest(
    config,
    `/sources/${config.sourceId}/resources`,
    datasetRequestOptions(accessToken),
  );
  return unwrapList(raw)
    .map(parseResource)
    .filter((item): item is SourceDatasetResource => item !== null);
}

function agentResourceAttributes() {
  return ["nativeIdentity", "identityName", "owner", "platform"].map((name) => ({
    name,
    nativeName: null,
    type: "STRING",
    schema: null,
    description: name,
    isMulti: false,
    isEntitlement: false,
    isGroup: false,
    isManaged: false,
  }));
}

export async function createAgentResourceSchema(
  config: IscConfig,
  input: { datasetId: string; resourceId: string; name?: string },
  accessToken?: string,
): Promise<unknown> {
  const resourceId = input.resourceId.trim();
  return iscRequest(
    config,
    `/sources/${config.sourceId}/schemas`,
    {
      method: "POST",
      body: {
        name: input.name?.trim() || resourceId,
        nativeObjectType: resourceId,
        identityAttribute: "nativeIdentity",
        displayAttribute: "identityName",
        configuration: {
          datasetId: input.datasetId,
          resourceId,
          resourceType: AGENT_RESOURCE_TYPE,
        },
        attributes: agentResourceAttributes(),
      },
      ...datasetRequestOptions(accessToken),
    },
  );
}

export function matchDataset(
  datasets: SourceDataset[],
  preferredId: string,
): SourceDataset | undefined {
  const needle = preferredId.trim().toLowerCase();
  if (!needle) {
    return undefined;
  }
  return datasets.find(
    (dataset) =>
      dataset.id.toLowerCase() === needle ||
      dataset.name.toLowerCase() === needle,
  );
}

export function matchAgentResource(
  resources: SourceDatasetResource[],
  preferredId: string,
): SourceDatasetResource | undefined {
  const needle = preferredId.trim().toLowerCase();
  return resources.find((resource) => {
    const id = resource.id.toLowerCase();
    const name = resource.name.toLowerCase();
    return id === needle || name === needle;
  });
}

export async function resolveSourceDatasetIds(
  config: IscConfig,
  preferredIds: string[],
): Promise<string[]> {
  if (preferredIds.length === 0) {
    throw new Error(
      "Dataset aggregation requires at least one dataset id (e.g. bedrock-agent).",
    );
  }

  try {
    const datasets = await listSourceDatasets(config);
    if (datasets.length === 0) {
      return preferredIds;
    }

    const resolved: string[] = [];
    for (const preferred of preferredIds) {
      const match = matchDataset(datasets, preferred);
      resolved.push(match?.id ?? preferred);
    }
    return resolved;
  } catch {
    return preferredIds;
  }
}

export async function ensureAgentDataset(
  config: IscConfig,
  spec: AgentDatasetSpec,
  accessToken?: string,
): Promise<EnsureAgentDatasetResult> {
  const preferredId = spec.datasetId.trim();
  if (!preferredId) {
    throw new Error("datasetId is required to ensure an agent dataset.");
  }

  let datasets: SourceDataset[] = [];
  try {
    datasets = await listSourceDatasets(config, accessToken);
  } catch {
    datasets = [];
  }

  let createdDataset = false;
  let dataset = matchDataset(datasets, preferredId);

  if (!dataset) {
    dataset = await createSourceDataset(
      config,
      {
        id: preferredId,
        name: spec.displayName?.trim() || preferredId,
        description:
          spec.description?.trim() ||
          `AgentForge dataset for ${preferredId} agent resources`,
        aggregationEnabled: true,
      },
      accessToken,
    );
    createdDataset = true;
  }

  let resources: SourceDatasetResource[] = [];
  try {
    resources = await listSourceResources(config, accessToken);
  } catch {
    resources = [];
  }

  let createdResource = false;
  const resource = matchAgentResource(resources, preferredId);
  let schemaExists = Boolean(resource);
  if (!schemaExists) {
    try {
      const schemas = await listSourceSchemas(config, accessToken);
      schemaExists = schemas.some(
        (schema) =>
          schema.name?.toLowerCase() === preferredId.toLowerCase() ||
          (typeof schema.configuration?.datasetId === "string" &&
            schema.configuration.datasetId.toLowerCase() ===
              preferredId.toLowerCase()),
      );
    } catch {
      schemaExists = false;
    }
  }
  if (!schemaExists) {
    await createAgentResourceSchema(
      config,
      { datasetId: dataset.id, resourceId: preferredId, name: preferredId },
      accessToken,
    );
    createdResource = true;
  }

  return { dataset, createdDataset, createdResource };
}
