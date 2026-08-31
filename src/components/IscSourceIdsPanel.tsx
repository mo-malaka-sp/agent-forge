"use client";

import { useCallback, useEffect, useState } from "react";

import {
  hasIscSessionCache,
  loadIscSessionCache,
  saveIscSessionCache,
  withIscRuntimeBody,
} from "@/lib/isc/session-cache";
import {
  DEPLOYMENT_PROVIDERS,
  DEPLOYMENT_PROVIDER_VALUES,
  type DeploymentProvider,
} from "@/lib/providers/profiles";

type SourceMap = Record<DeploymentProvider, string>;

type VerifyState = Partial<
  Record<DeploymentProvider, { ok: boolean; message: string }>
>;

const EMPTY_SOURCES: SourceMap = {
  aws_bedrock: "",
  gcp_vertex: "",
  azure_ai_foundry: "",
};

function defaultMisSchemas(): Record<DeploymentProvider, string> {
  return {
    aws_bedrock: DEPLOYMENT_PROVIDERS.aws_bedrock.misSchemaId,
    gcp_vertex: DEPLOYMENT_PROVIDERS.gcp_vertex.misSchemaId,
    azure_ai_foundry: DEPLOYMENT_PROVIDERS.azure_ai_foundry.misSchemaId,
  };
}

function buildSourcesPatch(
  formSources: SourceMap,
  baseline: SourceMap,
): Partial<SourceMap> {
  const patch: Partial<SourceMap> = {};

  for (const provider of DEPLOYMENT_PROVIDER_VALUES) {
    const next = formSources[provider].trim();
    const prev = baseline[provider].trim();

    if (next) {
      patch[provider] = next;
      continue;
    }

    if (prev) {
      patch[provider] = "";
    }
  }

  return patch;
}

function formatSavedPlatforms(patch: Partial<SourceMap>): string {
  const labels = DEPLOYMENT_PROVIDER_VALUES.filter((provider) =>
    Boolean(patch[provider]?.trim()),
  ).map((provider) => DEPLOYMENT_PROVIDERS[provider].label);

  if (labels.length === 0) {
    return "Source ID cleared.";
  }

  if (labels.length === 1) {
    return `${labels[0]} source ID saved.`;
  }

  return `Source IDs saved for ${labels.join(", ")}.`;
}

interface IscSourceIdsPanelProps {
  credentialsConfigured: boolean;
  tenant: string | null;
  apiBaseUrl?: string | null;
  credentialSource?: "ui" | "env" | "session" | null;
  onSourcesChange?: () => void;
}

export function IscSourceIdsPanel({
  credentialsConfigured,
  tenant,
  apiBaseUrl,
  credentialSource,
  onSourcesChange,
}: IscSourceIdsPanelProps) {
  const [sources, setSources] = useState<SourceMap>(EMPTY_SOURCES);
  const [datasetIds, setDatasetIds] = useState<SourceMap>(defaultMisSchemas());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState<DeploymentProvider | null>(null);
  const [verifyState, setVerifyState] = useState<VerifyState>({});
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [savedBaseline, setSavedBaseline] = useState<SourceMap>(EMPTY_SOURCES);

  const connectionReady = credentialsConfigured || hasIscSessionCache();

  const savedCount = DEPLOYMENT_PROVIDER_VALUES.filter((provider) =>
    Boolean(sources[provider].trim()),
  ).length;

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/isc/sources");
      const body = (await response.json()) as {
        sources?: SourceMap;
        misSchemas?: SourceMap;
        datasetIds?: SourceMap;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error ?? "Failed to load ISC sources");
      }

      const cached = loadIscSessionCache();

      const loaded: SourceMap = {
        aws_bedrock:
          body.sources?.aws_bedrock || cached?.sources.aws_bedrock || "",
        gcp_vertex: body.sources?.gcp_vertex || cached?.sources.gcp_vertex || "",
        azure_ai_foundry:
          body.sources?.azure_ai_foundry ||
          cached?.sources.azure_ai_foundry ||
          "",
      };

      setSources(loaded);
      setSavedBaseline(loaded);
      setDatasetIds({
        ...defaultMisSchemas(),
        ...(body.datasetIds ?? body.misSchemas ?? {}),
        ...(cached?.mis_schemas ?? {}),
      });
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load ISC sources",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  async function persistSources(
    formSources: SourceMap,
    options?: { quiet?: boolean; baseline?: SourceMap },
  ) {
    const patch = buildSourcesPatch(formSources, options?.baseline ?? savedBaseline);
    const misSchemas = {
      ...defaultMisSchemas(),
      ...datasetIds,
    };

    if (Object.keys(patch).length === 0 && !hasAnySource) {
      if (!options?.quiet) {
        setError("Enter at least one source ID before saving.");
      }
      return;
    }

    setSaving(true);
    if (!options?.quiet) {
      setError(null);
      setSavedMessage(null);
    }

    try {
      const response = await fetch("/api/isc/sources", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(Object.keys(patch).length > 0 ? { sources: patch } : {}),
          dataset_ids: misSchemas,
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        sources?: SourceMap;
      };

      if (!response.ok) {
        throw new Error(body.error ?? "Failed to save ISC sources");
      }

      const merged: SourceMap = {
        ...EMPTY_SOURCES,
        ...(body.sources ?? {}),
        ...patch,
      };
      setSources(merged);
      setSavedBaseline(merged);

      const cached = loadIscSessionCache();
      if (cached) {
        saveIscSessionCache({
          sources: merged,
          mis_schemas: misSchemas,
        });
      }

      if (!options?.quiet) {
        setSavedMessage(formatSavedPlatforms(patch));
      }
      onSourcesChange?.();
    } catch (saveError) {
      if (!options?.quiet) {
        setError(
          saveError instanceof Error ? saveError.message : "Failed to save",
        );
      } else {
        throw saveError;
      }
    } finally {
      setSaving(false);
    }
  }

  async function verifySource(provider: DeploymentProvider) {
    if (!connectionReady) {
      setError("Save ISC tenant credentials in Connect before verifying sources.");
      return;
    }

    const sourceId = sources[provider].trim();
    if (!sourceId) {
      setError(`Enter a source ID for ${DEPLOYMENT_PROVIDERS[provider].label}.`);
      return;
    }

    setVerifying(provider);
    setError(null);

    try {
      await persistSources(sources, { quiet: true, baseline: savedBaseline });

      const response = await fetch("/api/isc/sources/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withIscRuntimeBody({
            provider,
            source_id: sourceId,
          }),
        ),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };

      setVerifyState((current) => ({
        ...current,
        [provider]: {
          ok: body.ok === true,
          message: body.message ?? body.error ?? "Verification failed",
        },
      }));
    } catch (verifyError) {
      setVerifyState((current) => ({
        ...current,
        [provider]: {
          ok: false,
          message:
            verifyError instanceof Error
              ? verifyError.message
              : "Verification failed",
        },
      }));
    } finally {
      setVerifying(null);
    }
  }

  const hasAnySource = DEPLOYMENT_PROVIDER_VALUES.some((provider) =>
    Boolean(sources[provider].trim()),
  );

  return (
    <section className="space-y-3 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-950">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Web Services source IDs
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Available after golden import — copy each source ID from{" "}
          <strong>Admin → Connections → Sources</strong>
          {tenant ? (
            <>
              {" "}
              on tenant <span className="font-mono">{tenant}</span>
            </>
          ) : null}
          . Save one platform at a time — you only need the source(s) you plan to
          demo. Dataset ID is the ISC <strong>Dataset Management</strong> id used
          for agent aggregation (defaults shown below).
        </p>
        {savedCount > 0 ? (
          <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
            {savedCount}/3 source IDs saved.
          </p>
        ) : null}
        {apiBaseUrl ? (
          <p className="mt-1 font-mono text-[10px] text-zinc-500">
            Verify calls: {apiBaseUrl}
            {credentialSource === "env" ? (
              <span className="text-amber-700 dark:text-amber-300">
                {" "}
                — using server env vars
              </span>
            ) : null}
          </p>
        ) : null}
      </div>

      {!connectionReady ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Complete <strong>Connect</strong> first — save tenant credentials before
          registering source IDs.
        </p>
      ) : null}

      {loading ? (
        <p className="text-xs text-zinc-500">Loading source settings...</p>
      ) : (
        <div className="space-y-3">
          {DEPLOYMENT_PROVIDER_VALUES.map((provider) => {
            const verify = verifyState[provider];
            return (
              <div
                key={provider}
                className="space-y-1.5 rounded-md border border-zinc-200 p-3 dark:border-zinc-700"
              >
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {DEPLOYMENT_PROVIDERS[provider].label}
                </p>
                <label className="block space-y-1">
                  <span className="text-[11px] text-zinc-500">Source ID</span>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={sources[provider]}
                      onChange={(event) =>
                        setSources((current) => ({
                          ...current,
                          [provider]: event.target.value,
                        }))
                      }
                      placeholder="From ISC after import"
                      disabled={!connectionReady}
                      className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900"
                    />
                    <button
                      type="button"
                      onClick={() => void verifySource(provider)}
                      disabled={
                        !sources[provider].trim() ||
                        verifying !== null ||
                        !connectionReady
                      }
                      className="rounded-md border border-zinc-300 px-3 py-2 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      {verifying === provider ? "Verifying..." : "Verify"}
                    </button>
                  </div>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-zinc-500">
                    Dataset ID (default {DEPLOYMENT_PROVIDERS[provider].misSchemaId})
                  </span>
                  <input
                    value={datasetIds[provider]}
                    onChange={(event) =>
                      setDatasetIds((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                    placeholder={DEPLOYMENT_PROVIDERS[provider].misSchemaId}
                    disabled={!connectionReady}
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                {verify ? (
                  <p
                    className={`text-xs ${
                      verify.ok
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-red-700 dark:text-red-300"
                    }`}
                  >
                    {verify.message}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void persistSources(sources)}
          disabled={saving || loading || !connectionReady || !hasAnySource}
          className="rounded-md bg-zinc-900 px-4 py-2 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving..." : "Save entered source IDs"}
        </button>
        {savedMessage ? (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">
            {savedMessage}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-red-700 dark:text-red-300">{error}</p>
      ) : null}
    </section>
  );
}
