import { iscRequest } from "@/lib/isc/client";
import type { IscConfig } from "@/lib/isc/config";

const BASE_URL_ATTRIBUTE = "genericWebServiceBaseUrl";

interface ConnectionParameter {
  contextUrl?: string;
  [key: string]: unknown;
}

interface SourceWithConnectorAttributes {
  id?: string;
  name?: string;
  connectorAttributes?: {
    genericWebServiceBaseUrl?: string;
    connectionParameters?: ConnectionParameter[];
    [key: string]: unknown;
  };
}

export interface SourceBaseUrlState {
  sourceId: string;
  sourceName: string | null;
  /** Base URL currently stored on the ISC source, if the connector exposes one. */
  baseUrl: string | null;
  /** Absolute contextUrls that point somewhere other than the expected base URL. */
  staleContextUrls: string[];
}

export interface SourceBaseUrlRepairResult extends SourceBaseUrlState {
  expectedBaseUrl: string;
  changed: boolean;
  previousBaseUrl: string | null;
}

function normalize(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function isAbsolute(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function isUnreachableBaseUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function collectStaleContextUrls(
  source: SourceWithConnectorAttributes,
  expectedBaseUrl: string,
): string[] {
  const expected = normalize(expectedBaseUrl);
  const parameters = source.connectorAttributes?.connectionParameters ?? [];

  return parameters
    .map((parameter) => parameter.contextUrl?.trim())
    .filter((contextUrl): contextUrl is string => Boolean(contextUrl))
    .filter(
      (contextUrl) => isAbsolute(contextUrl) && !contextUrl.startsWith(expected),
    );
}

export async function readSourceBaseUrl(
  config: IscConfig,
  expectedBaseUrl?: string,
): Promise<SourceBaseUrlState> {
  const source = await iscRequest<SourceWithConnectorAttributes>(
    config,
    `/sources/${config.sourceId}`,
  );

  const baseUrl =
    source.connectorAttributes?.[BASE_URL_ATTRIBUTE]?.trim() || null;

  return {
    sourceId: config.sourceId,
    sourceName: source.name?.trim() ?? null,
    baseUrl,
    staleContextUrls: expectedBaseUrl
      ? collectStaleContextUrls(source, expectedBaseUrl)
      : [],
  };
}

/**
 * Point an already-imported Web Services source back at this AgentForge
 * deployment. Sources imported from a laptop keep the base URL that was baked
 * into the golden package at download time, so ISC calls localhost forever.
 */
export async function repairSourceBaseUrl(
  config: IscConfig,
  expectedBaseUrl: string,
  accessToken?: string,
): Promise<SourceBaseUrlRepairResult> {
  const expected = normalize(expectedBaseUrl);
  const current = await readSourceBaseUrl(config, expected);

  if (current.baseUrl === null) {
    throw new Error(
      `Source ${config.sourceId} has no ${BASE_URL_ATTRIBUTE} attribute — it is not a Web Services source.`,
    );
  }

  if (normalize(current.baseUrl) === expected) {
    return {
      ...current,
      expectedBaseUrl: expected,
      changed: false,
      previousBaseUrl: current.baseUrl,
    };
  }

  await iscRequest(config, `/sources/${config.sourceId}`, {
    method: "PATCH",
    bodyMode: "json-patch",
    body: [
      {
        op: "replace",
        path: `/connectorAttributes/${BASE_URL_ATTRIBUTE}`,
        value: expected,
      },
    ],
    accessToken,
  });

  const updated = await readSourceBaseUrl(config, expected);

  return {
    ...updated,
    expectedBaseUrl: expected,
    changed: true,
    previousBaseUrl: current.baseUrl,
  };
}
