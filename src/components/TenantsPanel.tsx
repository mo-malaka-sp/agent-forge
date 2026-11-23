"use client";

import { useEffect, useState } from "react";

import {
  loadTenantState,
  saveTenantBinding,
  type TenantState,
} from "@/components/TenantPicker";
import {
  TENANT_SOURCE_PROVIDERS,
  type ConnectionCheck,
  type IscProfilePublic,
  type TenantFeature,
} from "@/lib/isc/profile-types";

type Form = {
  name: string;
  tenant: string;
  domain: string;
  clientId: string;
  clientSecret: string;
  sources: Record<(typeof TENANT_SOURCE_PROVIDERS)[number], string>;
  passwordClientId: string;
  passwordClientSecret: string;
  ownerId: string;
  ownerName: string;
  triggerName: string;
  notifyEmail: string;
};

const SOURCE_LABELS: Record<(typeof TENANT_SOURCE_PROVIDERS)[number], string> = {
  aws_bedrock: "AWS Bedrock source ID",
  gcp_vertex: "GCP Vertex source ID",
  azure_ai_foundry: "Azure AI Foundry source ID",
};

function emptyForm(): Form {
  return {
    name: "",
    tenant: "",
    domain: "identitynow.com",
    clientId: "",
    clientSecret: "",
    sources: { aws_bedrock: "", gcp_vertex: "", azure_ai_foundry: "" },
    passwordClientId: "",
    passwordClientSecret: "",
    ownerId: "",
    ownerName: "",
    triggerName: "CAEP Risk Level Change Events",
    notifyEmail: "",
  };
}

function formFromProfile(profile: IscProfilePublic): Form {
  return {
    name: profile.name,
    tenant: profile.tenant,
    domain: profile.domain,
    clientId: profile.clientId,
    clientSecret: "",
    sources: {
      aws_bedrock: profile.sources.aws_bedrock ?? "",
      gcp_vertex: profile.sources.gcp_vertex ?? "",
      azure_ai_foundry: profile.sources.azure_ai_foundry ?? "",
    },
    passwordClientId: profile.passwordClientId,
    passwordClientSecret: "",
    ownerId: profile.ownerId,
    ownerName: profile.ownerName,
    triggerName: profile.triggerName,
    notifyEmail: profile.notifyEmail,
  };
}

function requestBody(form: Form, id?: string) {
  return {
    ...(id ? { id } : {}),
    name: form.name,
    tenant: form.tenant,
    domain: form.domain,
    clientId: form.clientId,
    clientSecret: form.clientSecret,
    sources: form.sources,
    passwordClientId: form.passwordClientId,
    passwordClientSecret: form.passwordClientSecret,
    ownerId: form.ownerId,
    ownerName: form.ownerName,
    triggerName: form.triggerName,
    notifyEmail: form.notifyEmail,
  };
}

async function postJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(parsed.error ?? `Request failed (${response.status}).`);
  }
  return parsed;
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
      />
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

function CheckResult({ title, check }: { title: string; check: ConnectionCheck }) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className={check.ok ? "font-medium text-emerald-700 dark:text-emerald-400" : "font-medium text-red-600 dark:text-red-400"}>
        {title}: {check.ok ? "connected" : "not connected"} ({check.host})
      </p>
      <ul className="space-y-1">
        {check.steps.map((step) => (
          <li key={step.id} className="flex gap-2 text-xs">
            <span className={step.ok ? "text-emerald-600" : step.required ? "text-red-600" : "text-amber-600"}>
              {step.ok ? "OK" : step.required ? "FAIL" : "NOTE"}
            </span>
            <span className="font-mono">{step.label}</span>
            <span className="text-zinc-600 dark:text-zinc-400">{step.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TenantsPanel() {
  const [state, setState] = useState<TenantState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ title: string; check: ConnectionCheck } | null>(null);

  async function refresh() {
    try {
      setState(await loadTenantState());
      setLoadError(null);
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Saved tenants could not be loaded.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    loadTenantState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setLoadError(caught instanceof Error ? caught.message : "Saved tenants could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(profile: IscProfilePublic) {
    setEditingId(profile.id);
    setForm(formFromProfile(profile));
    setShowAdvanced(true);
    setMessage(null);
    setError(null);
    setResult(null);
  }

  function startNew() {
    setEditingId(null);
    setForm(emptyForm());
    setShowAdvanced(false);
    setMessage(null);
    setError(null);
    setResult(null);
  }

  async function check() {
    setBusy("check");
    setError(null);
    setResult(null);
    try {
      const body = await postJson<{ check: ConnectionCheck }>(
        "/api/isc/profiles/check",
        "POST",
        requestBody(form, editingId ?? undefined),
      );
      setResult({ title: "Check", check: body.check });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Check failed.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    setMessage(null);
    try {
      if (editingId) {
        await postJson("/api/isc/profiles/" + editingId, "PUT", requestBody(form));
        setMessage(`Saved ${form.name}.`);
      } else {
        await postJson("/api/isc/profiles", "POST", requestBody(form));
        setMessage(`Added ${form.name}.`);
        setForm(emptyForm());
      }
      setEditingId(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  async function test(profile: IscProfilePublic) {
    setBusy(`test:${profile.id}`);
    setError(null);
    setResult(null);
    try {
      const body = await postJson<{ check: ConnectionCheck }>(
        `/api/isc/profiles/${profile.id}/test`,
        "POST",
        {},
      );
      setResult({ title: profile.name, check: body.check });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Test failed.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(profile: IscProfilePublic) {
    if (!window.confirm(`Delete the saved tenant "${profile.name}"? Its features will fall back to the default.`)) {
      return;
    }
    setBusy(`delete:${profile.id}`);
    setError(null);
    try {
      await postJson(`/api/isc/profiles/${profile.id}`, "DELETE", {});
      setMessage(`Deleted ${profile.name}.`);
      if (editingId === profile.id) startNew();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed.");
    } finally {
      setBusy(null);
    }
  }

  async function assign(feature: TenantFeature, profileId: string | null) {
    setBusy(`bind:${feature}`);
    setError(null);
    try {
      const bindings = await saveTenantBinding(feature, profileId);
      setState((current) => (current ? { ...current, bindings } : current));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The tenant could not be assigned.");
    } finally {
      setBusy(null);
    }
  }

  const profiles = state?.profiles ?? [];
  const bindings = state?.bindings ?? {};

  return (
    <div className="space-y-8">
      {state?.storageProblem ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {state.storageProblem}
        </p>
      ) : null}
      {loadError ? <p className="text-sm text-red-600">{loadError}</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p> : null}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Saved tenants</h2>
        {profiles.length === 0 ? (
          <p className="text-sm text-zinc-500">No saved tenants yet. Add one below.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Tenant</th>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Last test</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {profiles.map((profile) => (
                  <tr key={profile.id} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="px-3 py-2 font-medium">{profile.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{profile.tenantUrl}</td>
                    <td className="px-3 py-2 text-xs">
                      {profile.clientId.slice(0, 8)}… {profile.clientSecretSet ? "· secret saved" : "· no secret"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {profile.lastTest ? (
                        <span className={profile.lastTest.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                          {profile.lastTest.ok ? "Connected" : "Failed"} · {new Date(profile.lastTest.at).toLocaleString()}
                        </span>
                      ) : (
                        <span className="text-zinc-500">Not tested</span>
                      )}
                    </td>
                    <td className="space-x-2 px-3 py-2 text-right text-xs">
                      <button type="button" onClick={() => void test(profile)} disabled={busy !== null} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700">
                        {busy === `test:${profile.id}` ? "Testing…" : "Test"}
                      </button>
                      <button type="button" onClick={() => startEdit(profile)} disabled={busy !== null} className="rounded border border-zinc-300 px-2 py-1 disabled:opacity-50 dark:border-zinc-700">
                        Edit
                      </button>
                      <button type="button" onClick={() => void remove(profile)} disabled={busy !== null} className="rounded border border-red-300 px-2 py-1 text-red-600 disabled:opacity-50 dark:border-red-800">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result ? <CheckResult title={result.title} check={result.check} /> : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Which tenant each feature uses</h2>
        <p className="text-xs text-zinc-500">
          Each feature can point at a different tenant. Features set to use the default follow the default tenant.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(state?.features ?? []).map((feature) => (
            <label key={feature.id} className="space-y-1 text-sm">
              <span className="font-medium">{feature.label}</span>
              <select
                value={bindings[feature.id] ?? ""}
                disabled={busy !== null || profiles.length === 0}
                onChange={(event) => void assign(feature.id, event.target.value || null)}
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">{feature.id === "default" ? "None" : "Use default"}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} ({profile.tenant}.{profile.domain})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{editingId ? `Edit ${form.name || "tenant"}` : "Add a tenant"}</h2>
          {editingId ? (
            <button type="button" onClick={startNew} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              Start a new tenant instead
            </button>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" value={form.name} onChange={(value) => update("name", value)} placeholder="Demo tenant for Datadog" />
          <Field
            label="Tenant"
            value={form.tenant}
            onChange={(value) => update("tenant", value)}
            placeholder="beta-26912 or https://beta-26912.identitynow-demo.com/"
            hint="A pasted URL also fills in the domain."
          />
          <Field label="Domain" value={form.domain} onChange={(value) => update("domain", value)} placeholder="identitynow-demo.com" />
          <Field label="Client ID" value={form.clientId} onChange={(value) => update("clientId", value)} />
          <Field
            label="Client secret"
            type="password"
            value={form.clientSecret}
            onChange={(value) => update("clientSecret", value)}
            placeholder={editingId ? "Saved. Leave blank to keep it." : ""}
          />
        </div>

        <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
          {showAdvanced ? "Hide" : "Show"} SAF settings for this tenant
        </button>
        {showAdvanced ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Password client ID" value={form.passwordClientId} onChange={(value) => update("passwordClientId", value)} hint="Used to set Test Drive passwords." />
            <Field label="Password client secret" type="password" value={form.passwordClientSecret} onChange={(value) => update("passwordClientSecret", value)} placeholder={editingId ? "Saved. Leave blank to keep it." : ""} />
            <Field label="Owner ID" value={form.ownerId} onChange={(value) => update("ownerId", value)} />
            <Field label="Owner name" value={form.ownerName} onChange={(value) => update("ownerName", value)} />
            <Field label="CAEP trigger name" value={form.triggerName} onChange={(value) => update("triggerName", value)} />
            <Field label="Notify email" value={form.notifyEmail} onChange={(value) => update("notifyEmail", value)} />
            {TENANT_SOURCE_PROVIDERS.map((provider) => (
              <Field
                key={provider}
                label={SOURCE_LABELS[provider]}
                value={form.sources[provider]}
                onChange={(value) => setForm((current) => ({ ...current, sources: { ...current.sources, [provider]: value } }))}
                hint="Needed for Govern on this tenant."
              />
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void check()} disabled={busy !== null} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700">
            {busy === "check" ? "Checking…" : "Check connection"}
          </button>
          <button type="button" onClick={() => void save()} disabled={busy !== null} className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
            {busy === "save" ? "Saving…" : editingId ? "Save changes" : "Add tenant"}
          </button>
        </div>
      </section>
    </div>
  );
}
