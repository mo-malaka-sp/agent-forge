"use client";

import {
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_PROVIDER_VALUES,
  type DeploymentProvider,
} from "@/lib/providers/profiles";

import type { IscRuntimePayload } from "./runtime-config";

const SESSION_KEY = "agentforge-isc-session";

export interface IscSessionCache {
  tenant: string;
  client_id: string;
  client_secret: string;
  api_version: string;
  domain: string;
  sources: Record<DeploymentProvider, string>;
  mis_schemas: Record<DeploymentProvider, string>;
  saved_at: string;
}

function emptySources(): Record<DeploymentProvider, string> {
  return {
    aws_bedrock: "",
    gcp_vertex: "",
    azure_ai_foundry: "",
  };
}

function defaultMisSchemas(): Record<DeploymentProvider, string> {
  return {
    aws_bedrock: DEPLOYMENT_PROVIDERS.aws_bedrock.misSchemaId,
    gcp_vertex: DEPLOYMENT_PROVIDERS.gcp_vertex.misSchemaId,
    azure_ai_foundry: DEPLOYMENT_PROVIDERS.azure_ai_foundry.misSchemaId,
  };
}

export function loadIscSessionCache(): IscSessionCache | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<IscSessionCache>;
    if (
      !parsed.tenant?.trim() ||
      !parsed.client_id?.trim() ||
      !parsed.client_secret?.trim()
    ) {
      return null;
    }

    return {
      tenant: parsed.tenant.trim(),
      client_id: parsed.client_id.trim(),
      client_secret: parsed.client_secret.trim(),
      api_version: parsed.api_version?.trim() || "v2026",
      domain: parsed.domain?.trim() || "identitynow.com",
      sources: { ...emptySources(), ...parsed.sources },
      mis_schemas: { ...defaultMisSchemas(), ...parsed.mis_schemas },
      saved_at: parsed.saved_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveIscSessionCache(patch: Partial<IscSessionCache>): IscSessionCache {
  const current = loadIscSessionCache();
  const next: IscSessionCache = {
    tenant: patch.tenant?.trim() || current?.tenant || "",
    client_id: patch.client_id?.trim() || current?.client_id || "",
    client_secret: patch.client_secret?.trim() || current?.client_secret || "",
    api_version:
      patch.api_version?.trim() || current?.api_version || "v2026",
    domain: patch.domain?.trim() || current?.domain || "identitynow.com",
    sources: { ...emptySources(), ...current?.sources, ...patch.sources },
    mis_schemas: {
      ...defaultMisSchemas(),
      ...current?.mis_schemas,
      ...patch.mis_schemas,
    },
    saved_at: new Date().toISOString(),
  };

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

export function clearIscSessionCache() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function hasIscSessionCache(): boolean {
  return loadIscSessionCache() !== null;
}

export function getIscRuntimePayload(): IscRuntimePayload | null {
  const cache = loadIscSessionCache();
  if (!cache) {
    return null;
  }

  const sources = Object.fromEntries(
    DEPLOYMENT_PROVIDER_VALUES.map((provider) => [
      provider,
      cache.sources[provider]?.trim() || "",
    ]),
  ) as Record<DeploymentProvider, string>;

  return {
    tenant: cache.tenant,
    client_id: cache.client_id,
    client_secret: cache.client_secret,
    api_version: cache.api_version,
    domain: cache.domain,
    sources,
  };
}

export function withIscRuntimeBody<T extends Record<string, unknown>>(
  body: T,
): T & { isc_runtime?: IscRuntimePayload } {
  // Each route runs against the saved tenant bound to its feature. The browser sends nothing.
  return body;
}

export function withIscRuntimeHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  // Saved tenant bindings decide the tenant on the server. The browser sends no session header.
  return headers;
}

export function getSessionConfiguredSources(): Record<
  DeploymentProvider,
  string | null
> {
  const cache = loadIscSessionCache();
  if (!cache) {
    return {
      aws_bedrock: null,
      gcp_vertex: null,
      azure_ai_foundry: null,
    };
  }

  return {
    aws_bedrock: cache.sources.aws_bedrock || null,
    gcp_vertex: cache.sources.gcp_vertex || null,
    azure_ai_foundry: cache.sources.azure_ai_foundry || null,
  };
}
