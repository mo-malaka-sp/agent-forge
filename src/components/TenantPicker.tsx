"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type {
  IscBindings,
  IscProfilePublic,
  TenantFeature,
} from "@/lib/isc/profile-types";

export type TenantState = {
  profiles: IscProfilePublic[];
  bindings: IscBindings;
  features: Array<{ id: TenantFeature; label: string }>;
  storageProblem: string | null;
};

export async function loadTenantState(): Promise<TenantState> {
  const response = await fetch("/api/isc/profiles", { cache: "no-store" });
  const body = (await response.json()) as Partial<TenantState> & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Saved tenants could not be loaded.");
  }
  return {
    profiles: body.profiles ?? [],
    bindings: body.bindings ?? {},
    features: body.features ?? [],
    storageProblem: body.storageProblem ?? null,
  };
}

export async function saveTenantBinding(
  feature: TenantFeature,
  profileId: string | null,
): Promise<IscBindings> {
  const response = await fetch("/api/isc/bindings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ feature, profileId }),
  });
  const body = (await response.json()) as { bindings?: IscBindings; error?: string };
  if (!response.ok || !body.bindings) {
    throw new Error(body.error ?? "The tenant could not be assigned.");
  }
  return body.bindings;
}

export function tenantLabel(profile: IscProfilePublic | undefined | null): string {
  if (!profile) {
    return "No tenant saved yet";
  }
  return `${profile.name} (${profile.tenant}.${profile.domain})`;
}

/**
 * Chooses the saved tenant a feature uses. Shows the tenant in effect, including the default
 * when nothing is assigned to this feature.
 */
export function TenantPicker({ feature, label }: { feature: TenantFeature; label?: string }) {
  const [state, setState] = useState<TenantState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTenantState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Load failed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function choose(profileId: string | null) {
    setSaving(true);
    setError(null);
    try {
      const bindings = await saveTenantBinding(feature, profileId);
      setState((current) => (current ? { ...current, bindings } : current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The tenant could not be assigned.");
    } finally {
      setSaving(false);
    }
  }

  const profiles = state?.profiles ?? [];
  const bindings = state?.bindings ?? {};
  const assigned = bindings[feature] || null;
  const defaultId = bindings.default || null;
  const effective = profiles.find((profile) => profile.id === (assigned || defaultId));

  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{label ?? "SailPoint tenant"}</span>
        <Link href="/tenants" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          Manage saved tenants
        </Link>
      </div>
      {state ? (
        <>
          <select
            aria-label={label ?? "SailPoint tenant"}
            value={assigned ?? ""}
            disabled={saving || profiles.length === 0}
            onChange={(event) => void choose(event.target.value || null)}
            className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">
              {defaultId
                ? `Use default (${tenantLabel(profiles.find((profile) => profile.id === defaultId))})`
                : "Use default (none saved)"}
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {tenantLabel(profile)}
              </option>
            ))}
          </select>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            In use: {tenantLabel(effective)}
            {assigned ? "" : " (default)"}
          </p>
          {profiles.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              No saved tenants. Add one on the Tenants page.
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-zinc-500">{error ?? "Loading saved tenants…"}</p>
      )}
      {error && state ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
