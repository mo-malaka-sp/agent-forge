"use client";

import { useCallback, useState } from "react";

type Check = { label: string; passed: boolean };

type SafState = {
  configured: boolean;
  tenant: string;
  notifyEmail: string;
  mode: "dry-run" | "datadog";
  webhookUrl: string;
  evidence: {
    passed: boolean;
    summary: {
      events: number;
      signals: number;
      failedDeliveries: number;
    };
    testCase1: { title: string; passed: boolean; checks: Check[] };
    testCase2: { title: string; passed: boolean; checks: Check[] };
  };
  transmitter: {
    issuer: string;
    discoveryUrl: string;
    jwksUrl: string;
    streamEndpoint: string;
    https: boolean;
    streamRegistered: boolean;
    streamStatus: string | null;
    deliveryMethod: string | null;
  };
  workflow: {
    workflowName: string;
    workflowId: string;
    trigger: { name: string; id: string };
    email: string;
    enabled: boolean;
    testExecutionId: string | null;
  } | null;
  events: Array<{
    id: string;
    source: string;
    scenario: string | null;
    event: { eventType: string; risk: { title: string; severity: string } };
    delivery: { mode: string; status: string; detail: string };
  }>;
};

type AgentOption = {
  id: string;
  name: string;
  riskLevel: string;
  email?: string;
  ownerName?: string;
  ownerEmail?: string;
  source?: string;
};

type SafPocPanelProps = {
  initialState: SafState | null;
  initialError: string | null;
  agents: AgentOption[];
  agentsError?: string | null;
};

const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];

export function SafPocPanel({
  initialState,
  initialError,
  agents,
  agentsError: initialAgentsError = null,
}: SafPocPanelProps) {
  const [state, setState] = useState<SafState | null>(initialState);
  const [agentOptions, setAgentOptions] = useState(agents);
  const [agentsError, setAgentsError] = useState(initialAgentsError);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [riskLevel, setRiskLevel] = useState("High");
  const [identityEmail, setIdentityEmail] = useState(
    usableEmail(agents[0]?.ownerEmail) || initialState?.notifyEmail || "",
  );
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);

  const load = useCallback(async () => {
    const response = await fetch("/api/saf-poc/state", { cache: "no-store" });
    const body = (await response.json()) as SafState & { error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? "Could not load SAF POC state.");
    }
    setState(body);
    setIdentityEmail((current) => current || body.notifyEmail || "");
  }, []);

  const loadAgents = useCallback(async () => {
    const response = await fetch("/api/saf-poc/agents", { cache: "no-store" });
    const body = (await response.json()) as { agents?: AgentOption[]; error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? "Could not load tenant agents.");
    }
    const nextAgents = body.agents ?? [];
    setAgentOptions(nextAgents);
    setAgentsError(nextAgents.length === 0 ? "This tenant returned no agents." : null);
    setAgentId((current) =>
      nextAgents.some((agent) => agent.id === current) ? current : (nextAgents[0]?.id ?? ""),
    );
  }, []);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  async function post(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await response.json()) as { error?: string; state?: SafState };
    if (!response.ok) {
      throw new Error(payload.error ?? `Request failed (${response.status}).`);
    }
    if (payload.state) {
      setState(payload.state);
    } else {
      await load();
    }
    return payload;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {state?.tenant ? `Tenant ${state.tenant}` : "Tenant not configured"}
            </p>
            <p className="text-xs text-zinc-500">
              Datadog mode: {state?.mode ?? "…"} · CAEP receiver:{" "}
              {state?.transmitter.streamRegistered
                ? state.transmitter.streamStatus
                : "not registered"}
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("refresh", async () => {
                await load();
                await loadAgents();
              })
            }
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
          >
            Refresh
          </button>
        </div>
        {state && !state.transmitter.https ? (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
            This origin is not HTTPS. SailPoint can register the receiver only after
            AgentForge is deployed, or while AGENTFORGE_BASE_URL is the public HTTPS URL.
          </p>
        ) : null}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-sm font-semibold">Test 1 — CAEP email</h2>
          <p className="text-xs text-zinc-500">
            Workflows listen for a CAEP risk-level change. That is separate from the
            Agentic Fabric fire-and-forget webhook used for Datadog.
          </p>
          <Endpoint label="Discovery" value={state?.transmitter.discoveryUrl ?? ""} />
          <Endpoint label="Stream" value={state?.transmitter.streamEndpoint ?? ""} />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("token", async () => {
                  const response = await fetch("/api/saf-poc/token");
                  const body = (await response.json()) as { token?: string; error?: string };
                  if (!response.ok) {
                    throw new Error(body.error ?? "Could not read the API token.");
                  }
                  setToken(body.token ?? "");
                })
              }
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
            >
              Reveal receiver token
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void run("setup", async () => {
                  await post("/api/saf-poc/setup-test1", { sendTest: true });
                  setMessage("Verification workflow saved and a test execution was sent.");
                })
              }
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white"
            >
              {busy === "setup" ? "Setting up…" : "Create email workflow"}
            </button>
          </div>
          {token ? (
            <p className="break-all rounded-md bg-zinc-100 p-2 font-mono text-[11px] dark:bg-zinc-900">
              {token}
            </p>
          ) : null}
          {state?.workflow ? (
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              {state.workflow.workflowName} is {state.workflow.enabled ? "enabled" : "disabled"} on{" "}
              {state.workflow.trigger.name}.
              {state.workflow.testExecutionId
                ? ` Test execution ${state.workflow.testExecutionId}.`
                : ""}
            </p>
          ) : null}
        </article>

        <article className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-sm font-semibold">Change an agent’s risk</h2>
          <p className="text-xs text-zinc-500">
            The event subject is the selected agent’s owner. The workflow email still goes
            to the address saved on the workflow.
          </p>
          <label className="block text-xs">
            Tenant agent
            <select
              value={agentId}
              onChange={(event) => {
                const nextId = event.target.value;
                setAgentId(nextId);
                const ownerEmail = usableEmail(
                  agentOptions.find((agent) => agent.id === nextId)?.ownerEmail,
                );
                if (ownerEmail) {
                  setIdentityEmail(ownerEmail);
                }
              }}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              {agentOptions.length === 0 ? (
                <option value="">No tenant agents</option>
              ) : (
                agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.ownerName ? ` · owner ${agent.ownerName}` : ""}
                    {agent.source ? ` · ${agent.source}` : ""} ({agent.riskLevel || "no risk"})
                  </option>
                ))
              )}
            </select>
          </label>
          {agentsError ? <p className="text-xs text-red-700 dark:text-red-300">{agentsError}</p> : null}
          <label className="block text-xs">
            New risk level
            <select
              value={riskLevel}
              onChange={(event) => setRiskLevel(event.target.value)}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              {RISK_LEVELS.map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            Owner email
            <input
              value={identityEmail}
              onChange={(event) => setIdentityEmail(event.target.value)}
              placeholder="admin@example.com"
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="button"
            disabled={busy !== null || !agentId}
            onClick={() =>
              void run("risk", async () => {
                const selected = agentOptions.find((agent) => agent.id === agentId);
                const payload = await post("/api/saf-poc/risk", {
                  agentId,
                  agentName: selected?.name,
                  riskLevel,
                  previousLevel: selected?.riskLevel || "Low",
                  identityEmail,
                });
                const result = (
                  payload as {
                    result?: {
                      riskUpdate?: string;
                      caep?: { deliveries?: Array<{ detail: string }> } | null;
                    };
                  }
                ).result;
                if (result?.riskUpdate?.startsWith("SailPoint stored")) {
                  setAgentOptions((current) =>
                    current.map((agent) =>
                      agent.id === agentId ? { ...agent, riskLevel } : agent,
                    ),
                  );
                }
                const delivery = result?.caep?.deliveries?.[0]?.detail;
                setMessage(
                  [delivery, result?.riskUpdate].filter(Boolean).join(" ") ||
                    "Risk change recorded.",
                );
              })
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy === "risk" ? "Sending…" : "Change risk and emit events"}
          </button>
        </article>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Test 2 — Datadog intake</h2>
          <Endpoint label="Webhook" value={state?.webhookUrl ?? ""} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Point a SailPoint fire-and-forget webhook at this URL. Simulated events exercise
          the same pipeline without a tenant.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(
            [
              ["risk-state-changed", "Risk change"],
              ["exposed-credential", "Exposed credential"],
              ["critical-escalation", "Critical"],
              ["full-demo", "Full demo"],
            ] as const
          ).map(([scenario, label]) => (
            <button
              key={scenario}
              type="button"
              disabled={busy !== null}
              onClick={() => void run(scenario, () => post("/api/saf-poc/simulate", { scenario }).then(() => undefined))}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("reset", () => post("/api/saf-poc/reset").then(() => undefined))}
            className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 dark:border-red-900 dark:text-red-300"
          >
            Reset evidence
          </button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Checks title={state?.evidence.testCase1.title} checks={state?.evidence.testCase1.checks} />
          <Checks title={state?.evidence.testCase2.title} checks={state?.evidence.testCase2.checks} />
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="text-sm font-semibold">Recent events</h2>
        <ul className="mt-2 space-y-2">
          {(state?.events ?? []).slice(0, 8).map((event) => (
            <li key={event.id} className="text-xs text-zinc-600 dark:text-zinc-300">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {event.event.eventType}
              </span>{" "}
              {event.event.risk.title} · {event.delivery.mode}/{event.delivery.status}
              {event.scenario ? ` · ${event.scenario}` : ""}
            </li>
          ))}
          {(state?.events.length ?? 0) === 0 ? (
            <li className="text-xs text-zinc-500">No events yet.</li>
          ) : null}
        </ul>
      </section>

      {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    </div>
  );
}

function usableEmail(value?: string): string {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function Endpoint({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-[11px] text-zinc-500">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}: </span>
      <span className="break-all font-mono">{value || "—"}</span>
    </p>
  );
}

function Checks({ title, checks }: { title?: string; checks?: Check[] }) {
  return (
    <div>
      <p className="text-xs font-medium">{title}</p>
      <ul className="mt-1 space-y-1">
        {(checks ?? []).map((check) => (
          <li key={check.label} className="text-xs text-zinc-600 dark:text-zinc-300">
            {check.passed ? "Pass" : "Pending"} — {check.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
