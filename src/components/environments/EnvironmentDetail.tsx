"use client";

import { useState } from "react";

import { EnvironmentCleanup } from "@/components/environments/EnvironmentCleanup";
import { EnvironmentInventory } from "@/components/environments/EnvironmentInventory";
import { EnvironmentIscConfig } from "@/components/environments/EnvironmentIscConfig";
import { EnvironmentProgress } from "@/components/environments/EnvironmentProgress";
import { EnvironmentReady } from "@/components/environments/EnvironmentReady";
import { isRunReady } from "@/lib/environments/phases";
import type { DiscoveredAgent, EnvironmentRecord, EnvironmentRun } from "@/lib/environments/types";

export function EnvironmentDetail({
  id,
  initialEnvironment,
  initialRun,
  initialAgents,
  loadError,
}: {
  id: string;
  initialEnvironment: EnvironmentRecord | null;
  initialRun: EnvironmentRun | null;
  initialAgents: DiscoveredAgent[];
  loadError: string | null;
}) {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [run, setRun] = useState(initialRun);
  const [agents, setAgents] = useState(initialAgents);
  const [error, setError] = useState(loadError);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const response = await fetch(`/api/environments/${id}`, { cache: "no-store" });
    const body = (await response.json()) as {
      environment?: EnvironmentRecord;
      run?: EnvironmentRun | null;
      error?: string;
    };
    if (!response.ok || !body.environment) {
      throw new Error(body.error ?? "Could not load the environment.");
    }
    setEnvironment(body.environment);
    setRun(body.run ?? null);
    const discovered = await fetch(`/api/environments/${id}/discover`, { cache: "no-store" });
    const discoveredBody = (await discovered.json()) as { agents?: DiscoveredAgent[] };
    setAgents(discoveredBody.agents ?? []);
  }

  async function prepare(repair: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/environments/${id}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repair }),
      });
      const body = (await response.json()) as { error?: string; run?: EnvironmentRun };
      if (!response.ok || !body.run) {
        throw new Error(body.error ?? "Preparation did not start.");
      }
      setRun(body.run);
      await refresh();
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "Preparation did not start.");
    } finally {
      setBusy(false);
    }
  }

  if (!environment) {
    return <p className="text-sm text-zinc-600">{error ?? "Environment not found."}</p>;
  }

  const ready = run ? isRunReady(run) : false;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <p className="text-xs uppercase tracking-wide text-zinc-500">
          AWS · {environment.mode === "create" ? "Create FinBot demo" : "Existing environment"}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{environment.name}</h1>
        <p className="mt-1 break-all font-mono text-xs text-zinc-500">
          {environment.accountId} · {environment.region} · {environment.roleArn}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void prepare(false)}
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white"
          >
            {busy ? "Starting…" : "Prepare environment"}
          </button>
          <button
            type="button"
            disabled={busy || !run}
            onClick={() => void prepare(true)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium"
          >
            Repair setup
          </button>
        </div>
        {error ? (
          <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
            {error}
          </p>
        ) : null}
        {run?.codeBuildId ? (
          <p className="mt-3 text-xs text-zinc-500">CodeBuild {run.codeBuildId}</p>
        ) : null}
      </section>
      {run ? <EnvironmentProgress phases={run.phases} /> : null}
      <EnvironmentIscConfig sourceName={environment.iscSourceName} />
      <EnvironmentInventory agents={agents} />
      {ready ? <EnvironmentReady region={environment.region} agents={agents} /> : null}
      <EnvironmentCleanup id={id} />
    </div>
  );
}
