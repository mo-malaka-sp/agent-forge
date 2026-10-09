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
    subscription?: {
      id: string;
      enabled: boolean;
      triggerId: string;
      filter: string;
    } | null;
  } | null;
  datadogWorkflow: {
    workflowName: string;
    workflowId: string;
    trigger: { name: string; id: string };
    webhookUrl: string;
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

type AgentFinding = { title: string; detectedAt: string };

type ScoreView = {
  sentLevel: string;
  calculatedSeverity: string;
  findings: AgentFinding[];
  findingsNote: string;
  accepted: boolean;
  eventId: string;
  deliveryStatus: number | null;
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
  const [riskLevel, setRiskLevel] = useState(agents[0]?.riskLevel || "Low");
  const [identityEmail, setIdentityEmail] = useState(
    usableEmail(agents[0]?.ownerEmail) || initialState?.notifyEmail || "",
  );
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scoreView, setScoreView] = useState<ScoreView | null>(null);
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

      {message ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}

      <section className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div>
          <h2 className="text-base font-semibold">Test 1 — Prove the CAEP event bus</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Goal: AgentForge sends a real signed CAEP risk-level-change SET, SailPoint
            receiver Test1POC correlates it, and the enabled workflow sends the verification
            email. This test does not change the agent’s SAF Risk Severity card.
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">
            API contract: current SHF per-service endpoints{" "}
            <span className="font-mono">/workflows/v1</span>,{" "}
            <span className="font-mono">/workflow-library/v1/triggers</span>,{" "}
            <span className="font-mono">/trigger-subscriptions/v1</span>, and{" "}
            <span className="font-mono">/machine-identities/v1</span>. Management calls
            do not use deprecated yearly or <span className="font-mono">/v3</span>{" "}
            fallbacks.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <StoryStep
            number="1"
            title="Connect Test1POC"
            status={state?.transmitter.streamRegistered ? "Ready" : "Setup needed"}
            passed={Boolean(state?.transmitter.streamRegistered)}
          >
            SailPoint registers a push stream against AgentForge’s current SHF transmitter.
            The setup token is needed only while creating or repairing that receiver.
          </StoryStep>
          <StoryStep
            number="2"
            title="Prepare the workflow"
            status={state?.workflow?.enabled ? "Ready" : "Setup needed"}
            passed={Boolean(state?.workflow?.enabled)}
          >
            The workflow subscribes to <span className="font-mono">CAEP Risk Level Change</span>{" "}
            and sends the POC verification email. Its test execution checks only the email
            action; it bypasses the event bus.
          </StoryStep>
          <StoryStep
            number="3"
            title="Send and verify"
            status={
              scoreView
                ? scoreView.accepted
                  ? "Receiver accepted"
                  : "Delivery failed"
                : "Waiting"
            }
            passed={Boolean(scoreView?.accepted)}
          >
            Send the real SET below, then verify a correlated row under Test1POC, workflow
            subscription activity, and the email. Those three checks prove the full path.
          </StoryStep>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium">Receiver and workflow setup</h3>
            <Endpoint
              label="SHF discovery URL"
              value={state?.transmitter.discoveryUrl ?? ""}
            />
            <Endpoint
              label="SHF configuration endpoint"
              value={state?.transmitter.streamEndpoint ?? ""}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run("token", async () => {
                    const response = await fetch("/api/saf-poc/token");
                    const body = (await response.json()) as {
                      token?: string;
                      error?: string;
                    };
                    if (!response.ok) {
                      throw new Error(body.error ?? "Could not read the API token.");
                    }
                    setToken(body.token ?? "");
                  })
                }
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
              >
                Show Test1POC setup token
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run("setup", async () => {
                    await post("/api/saf-poc/setup-test1", { sendTest: true });
                    setMessage(
                      "Workflow saved and a direct test email was requested. That test bypasses the CAEP event bus.",
                    );
                  })
                }
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
              >
                {busy === "setup" ? "Preparing…" : "Create or repair workflow + test email"}
              </button>
            </div>
            {token ? (
              <div className="rounded-md bg-zinc-100 p-2 text-[11px] dark:bg-zinc-900">
                <p className="font-medium">Use as Test1POC receiver bearer token</p>
                <p className="mt-1 break-all font-mono">{token}</p>
              </div>
            ) : null}
            {state?.workflow ? (
              <div className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                <p>
                  Workflow: <strong>{state.workflow.workflowName}</strong> ·{" "}
                  {state.workflow.enabled ? "enabled" : "disabled"} · email{" "}
                  {state.workflow.email}
                </p>
                <p>
                  Trigger: {state.workflow.trigger.name} ({state.workflow.trigger.id})
                </p>
                <p>
                  Subscription:{" "}
                  {state.workflow.subscription
                    ? `${state.workflow.subscription.enabled ? "enabled" : "disabled"} · ${state.workflow.subscription.id}`
                    : "not returned yet"}
                </p>
                {state.workflow.testExecutionId ? (
                  <p>
                    Direct workflow test: {state.workflow.testExecutionId} — email-action
                    evidence only
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium">Send the real CAEP event</h3>
            <p className="text-xs text-zinc-500">
              The selected agent resolves a human owner email for CAEP subject correlation.
              The signal level is test data and does not write the SAF score.
            </p>
            <label className="block text-xs">
              Agent used to resolve the subject
              <select
                value={agentId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setAgentId(nextId);
                  setScoreView(null);
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
                      {agent.source ? ` · ${agent.source}` : ""}
                    </option>
                  ))
                )}
              </select>
            </label>
            {agentsError ? (
              <p className="text-xs text-red-700 dark:text-red-300">{agentsError}</p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                Signal level to send
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
                Correlated subject email
                <input
                  value={identityEmail}
                  onChange={(event) => setIdentityEmail(event.target.value)}
                  placeholder="admin@example.com"
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={busy !== null || !agentId || !usableEmail(identityEmail)}
              onClick={() =>
                void run("risk", async () => {
                  const selected = agentOptions.find((agent) => agent.id === agentId);
                  const payload = await post("/api/saf-poc/risk", {
                    agentId,
                    agentName: selected?.name,
                    riskLevel,
                    previousLevel: selected?.riskLevel || "Low",
                    identityEmail,
                    ingest: false,
                  });
                  const result = (
                    payload as {
                      result?: {
                        currentLevel?: string;
                        calculatedSeverity?: string;
                        findings?: AgentFinding[];
                        findingsNote?: string;
                        riskUpdate?: string;
                        caep?: {
                          deliveries?: Array<{
                            accepted?: boolean;
                            status?: number | null;
                            detail: string;
                            jti?: string;
                          }>;
                        } | null;
                      };
                    }
                  ).result;
                  const delivery = result?.caep?.deliveries?.[0];
                  setScoreView({
                    sentLevel: result?.currentLevel || riskLevel,
                    calculatedSeverity: result?.calculatedSeverity || "Unavailable",
                    findings: result?.findings ?? [],
                    findingsNote: result?.findingsNote || "",
                    accepted: Boolean(delivery?.accepted),
                    eventId: delivery?.jti || "",
                    deliveryStatus: delivery?.status ?? null,
                  });
                  setMessage(
                    delivery
                      ? `${delivery.detail}${delivery.jti ? ` Event ID ${delivery.jti}.` : ""}`
                      : result?.riskUpdate || "CAEP signal sent.",
                  );
                })
              }
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy === "risk" ? "Signing and sending…" : "Send real CAEP event to Test1POC"}
            </button>
            {scoreView ? (
              <div className="space-y-1 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                <p>
                  Sent CAEP level: <strong>{labelLevel(scoreView.sentLevel)}</strong>
                </p>
                <p>
                  Receiver delivery: {scoreView.accepted ? "accepted" : "not accepted"}
                  {scoreView.deliveryStatus ? ` · HTTP ${scoreView.deliveryStatus}` : ""}
                  {scoreView.eventId ? ` · event ID ${scoreView.eventId}` : ""}
                </p>
                <p>
                  Separate SAF calculated severity: {scoreView.calculatedSeverity}. This
                  value is displayed for context and was not changed by the CAEP event.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-medium">How to decide whether Test 1 passed</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>AgentForge reports the signed SET was accepted by the receiver endpoint.</li>
            <li>Test1POC shows a correlated row with the same subject and event ID.</li>
            <li>The workflow subscription activity increases and the email arrives.</li>
          </ol>
          <p className="mt-2">
            Current tenant finding: receiver correlation has been observed, while workflow
            subscription activity remained at zero. The direct workflow test is not a
            substitute for steps 1–3; it only proves the email action.
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Test 2 — Datadog intake</h2>
          <Endpoint label="Webhook" value={state?.webhookUrl ?? ""} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Intake mode is {state?.mode === "datadog" ? "Datadog" : "dry-run"}. The setup
          button creates the SailPoint workflow through{" "}
          <span className="font-mono">/workflows/v1</span> and{" "}
          <span className="font-mono">/workflow-library/v1/triggers</span>, then runs its
          test so SailPoint posts to this webhook. The scenario buttons below only prove
          AgentForge can reach Datadog. Confirm Live Tail with{" "}
          <span className="font-mono">source:sailpoint</span>. The critical query is{" "}
          <span className="font-mono">source:sailpoint @risk_severity:critical</span>.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("datadog-setup", async () => {
                await post("/api/saf-poc/setup-test2", { sendTest: true });
                setMessage(
                  "Datadog workflow saved and SailPoint was asked to post the webhook. Confirm a datadog/delivered row whose scenario is empty.",
                );
              })
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy === "datadog-setup"
              ? "Preparing…"
              : "Create or repair Datadog workflow + send test"}
          </button>
        </div>
        {state?.datadogWorkflow ? (
          <div className="mt-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
            <p>
              Workflow: <strong>{state.datadogWorkflow.workflowName}</strong> ·{" "}
              {state.datadogWorkflow.enabled ? "enabled" : "disabled"}
            </p>
            <p>
              Trigger: {state.datadogWorkflow.trigger.name} (
              {state.datadogWorkflow.trigger.id})
            </p>
            <p>Webhook: {state.datadogWorkflow.webhookUrl}</p>
            {state.datadogWorkflow.testExecutionId ? (
              <p>SailPoint workflow test: {state.datadogWorkflow.testExecutionId}</p>
            ) : null}
          </div>
        ) : null}
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
        <div className="mt-4">
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

    </div>
  );
}

function labelLevel(value: string): string {
  const level = value.trim().toLowerCase();
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : "Unavailable";
}

function usableEmail(value?: string): string {
  const email = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function StoryStep({
  number,
  title,
  status,
  passed,
  children,
}: {
  number: string;
  title: string;
  status: string;
  passed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-zinc-900 text-[11px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
          {number}
        </span>
        <p className="text-xs font-medium">{title}</p>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${
            passed
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300"
          }`}
        >
          {status}
        </span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">{children}</p>
    </div>
  );
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
