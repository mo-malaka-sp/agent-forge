"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SAILPOINT_DEMO_DURATION_MS, sailPointDemoDelayMs } from "@/lib/saf-poc/demo-stream";

type Check = { label: string; passed: boolean };

type SafState = {
  configured: boolean;
  tenant: string;
  notifyEmail: string;
  mode: "dry-run" | "datadog";
  signalRuleReady?: boolean;
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
  section: "caep" | "datadog";
  initialState: SafState | null;
  initialError: string | null;
  agents: AgentOption[];
  agentsError?: string | null;
};

const RISK_LEVELS = ["Low", "Medium", "High", "Critical"];
const DATADOG_SIGNALS_URL =
  "https://app.datadoghq.com/security/siem/signals?saved-view-id=4703495";

export function SafPocPanel({
  section,
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
  const [approach, setApproach] = useState<"test-event" | "agent-condition">("test-event");
  const [identityEmail, setIdentityEmail] = useState(
    usableEmail(agents[0]?.ownerEmail) || initialState?.notifyEmail || "",
  );
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [scoreView, setScoreView] = useState<ScoreView | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [demo, setDemo] = useState<{ until: number; sent: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const demoStop = useRef(false);
  const demoRunning = useRef(false);
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demoSent = useRef(0);

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

  useEffect(() => {
    if (!demo) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [demo]);

  useEffect(() => {
    return () => {
      demoStop.current = true;
      if (demoTimer.current !== null) window.clearTimeout(demoTimer.current);
    };
  }, []);

  function stopSailPointDemo(reason: "stopped" | "finished" | "failed") {
    demoStop.current = true;
    demoRunning.current = false;
    if (demoTimer.current !== null) {
      window.clearTimeout(demoTimer.current);
      demoTimer.current = null;
    }
    const sent = demoSent.current;
    setDemo(null);
    if (reason === "failed") {
      setError("SailPoint demo stopped after repeated delivery failures.");
      return;
    }
    setMessage(
      reason === "stopped"
        ? `SailPoint demo stopped after ${sent} logs.`
        : `SailPoint demo finished after 15 minutes. Sent ${sent} logs. Open the SailPoint rule and click View Signals.`,
    );
  }

  function startSailPointDemo() {
    if (demoRunning.current) return;
    demoRunning.current = true;
    demoStop.current = false;
    demoSent.current = 0;
    const until = Date.now() + SAILPOINT_DEMO_DURATION_MS;
    let index = 0;
    let failures = 0;
    setError(null);
    setNow(Date.now());
    setDemo({ until, sent: 0 });
    setMessage(
      "SailPoint demo is streaming for 15 minutes. Keep this tab open, then open the SailPoint rule and click View Signals.",
    );

    const tick = async () => {
      if (demoStop.current || Date.now() >= until) {
        stopSailPointDemo(demoStop.current ? "stopped" : "finished");
        return;
      }
      try {
        const payload = await post("/api/saf-poc/demo-stream", { index });
        failures = 0;
        index += 1;
        demoSent.current += typeof payload.sent === "number" ? payload.sent : 1;
        if (!demoStop.current) setDemo({ until, sent: demoSent.current });
      } catch (actionError) {
        failures += 1;
        setError(actionError instanceof Error ? actionError.message : "Request failed.");
        if (failures >= 3) {
          stopSailPointDemo("failed");
          return;
        }
      }
      if (demoStop.current || Date.now() >= until) {
        stopSailPointDemo(demoStop.current ? "stopped" : "finished");
        return;
      }
      demoTimer.current = setTimeout(() => void tick(), sailPointDemoDelayMs());
    };

    void tick();
  }

  async function post(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await response.json()) as { error?: string; state?: SafState; sent?: number };
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
              {section === "caep"
                ? `CAEP receiver: ${
                    state?.transmitter.streamRegistered
                      ? state.transmitter.streamStatus
                      : "not registered"
                  }`
                : `Datadog mode: ${state?.mode ?? "…"}`}
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
            Not HTTPS. SailPoint can only reach the deployed AgentForge URL.
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

      {section === "caep" ? (
      <section
        id="risk-response"
        className="space-y-4 scroll-mt-28 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div>
          <h2 className="text-base font-semibold">CAEP event bus</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Signed CAEP risk event → Test1POC receiver → workflow email.
          </p>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <StoryStep
            number="1"
            title="Connect Test1POC"
            status={state?.transmitter.streamRegistered ? "Ready" : "Setup needed"}
            passed={Boolean(state?.transmitter.streamRegistered)}
          >
            Register the receiver in SailPoint with the setup token.
          </StoryStep>
          <StoryStep
            number="2"
            title="Prepare the workflow"
            status={state?.workflow?.enabled ? "Ready" : "Setup needed"}
            passed={Boolean(state?.workflow?.enabled)}
          >
            Emails on <span className="font-mono">CAEP Risk Level Change</span>.
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
            The receiver correlates it, the workflow runs, and the email arrives.
          </StoryStep>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium">Setup</h3>
            <Endpoint
              label="Discovery URL"
              value={state?.transmitter.discoveryUrl ?? ""}
            />
            <Endpoint
              label="Stream endpoint"
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
                Show setup token
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void run("setup", async () => {
                    const payload = await post("/api/saf-poc/setup-test1", { sendTest: true });
                    const setup = (
                      payload as { setup?: { created?: boolean; repaired?: boolean } }
                    ).setup;
                    setMessage(
                      setup?.created
                        ? "Workflow created with the current email text. Test email sent. It bypasses the event bus. Mail already received stays unchanged."
                        : setup?.repaired
                          ? "Workflow email text was updated. Test email sent. It bypasses the event bus. Mail already received stays unchanged."
                          : "Workflow email text is already current. Test email sent. It bypasses the event bus. Mail already received stays unchanged.",
                    );
                  })
                }
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium dark:border-zinc-700"
              >
                {busy === "setup" ? "Preparing…" : "Set up workflow + test email"}
              </button>
            </div>
            {token ? (
              <div className="rounded-md bg-zinc-100 p-2 text-[11px] dark:bg-zinc-900">
                <p className="font-medium">Receiver bearer token</p>
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
                {state.workflow.subscription?.filter ? (
                  <p className="text-amber-700 dark:text-amber-300">
                    The trigger filter is set. Set up the workflow again so live events can start it.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <h3 className="text-sm font-medium">Send CAEP event</h3>
            <fieldset className="space-y-1 text-xs">
              <legend className="font-medium text-zinc-700 dark:text-zinc-200">Approach</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="caep-approach"
                  checked={approach === "test-event"}
                  onChange={() => setApproach("test-event")}
                />
                Test the event bus
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="caep-approach"
                  checked={approach === "agent-condition"}
                  onChange={() => {
                    setApproach("agent-condition");
                    setScoreView(null);
                  }}
                />
                Change a real agent condition
              </label>
            </fieldset>
            {approach === "agent-condition" ? (
              <p className="text-xs text-zinc-500">
                The Risk Engine recalculates only after a supported signal. AgentForge has no
                producer for one yet, so this choice does not send a CAEP event and does not set
                a severity.
              </p>
            ) : (
              <p className="text-xs text-zinc-500">
                Does not change Agent Risk Severity. The Risk Engine sets that band from weighted
                signals.
              </p>
            )}
            <label className="block text-xs">
              Agent
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
            {approach === "test-event" ? (
              <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                Risk level
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
                Subject email
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
                    mode: "test-event",
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
                    delivery?.accepted
                      ? `Receiver accepted event ${delivery.jti || ""}. Test1POC should show Correlated, then the workflow emails ${identityEmail}.`
                      : delivery
                        ? delivery.detail
                        : result?.riskUpdate || "CAEP signal sent.",
                  );
                })
              }
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
            >
              {busy === "risk" ? "Sending…" : "Send CAEP event"}
            </button>
            {scoreView ? (
              <div className="space-y-1 rounded-md bg-zinc-50 p-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                <p>
                  Sent: <strong>{labelLevel(scoreView.sentLevel)}</strong> ·{" "}
                  {scoreView.accepted ? "accepted" : "not accepted"}
                  {scoreView.deliveryStatus ? ` (HTTP ${scoreView.deliveryStatus})` : ""}
                </p>
                {scoreView.eventId ? <p>Event ID: {scoreView.eventId}</p> : null}
                <p>Agent Risk Severity: {scoreView.calculatedSeverity}. This event does not change it.</p>
              </div>
            ) : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="rounded-md border border-zinc-200 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">After you send</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>Test1POC shows the new row as Correlated for the subject email.</li>
            <li>The workflow execution marks Trigger, Send Email, and success.</li>
            <li>The email names the identity, the previous and current risk levels, and the reason.</li>
          </ol>
        </div>
      </section>
      ) : (
      <section
        id="security-signals"
        className="scroll-mt-28 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Datadog Security Signals</h2>
          <Endpoint label="Webhook" value={state?.webhookUrl ?? ""} />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          SailPoint workflow → this webhook → Datadog Security Inbox. Mode:{" "}
          {state?.mode === "datadog" ? "Datadog" : "dry-run"}. High and critical events
          open a signal. Search{" "}
          <span className="font-mono">source:sailpoint @evt.category:security</span>.
        </p>
        {state?.mode === "datadog" && !state.signalRuleReady ? (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Add DD_APP_KEY so Datadog can open those signals.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run("datadog-setup", async () => {
                await post("/api/saf-poc/setup-test2", { sendTest: true });
                setMessage("Workflow saved and run. Refresh to see the delivery.");
              })
            }
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy === "datadog-setup"
              ? "Preparing…"
              : "Set up workflow + send test"}
          </button>
          <a
            href={DATADOG_SIGNALS_URL}
            target="_blank"
            rel="noreferrer"
            className="datadog-link rounded-md px-3 py-1.5 text-xs font-medium"
          >
            <DatadogMark />
            Open Datadog signals
          </a>
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
            {state.datadogWorkflow.testExecutionId ? (
              <p>Test run: {state.datadogWorkflow.testExecutionId}</p>
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
            disabled={demo === null && busy !== null}
            onClick={() => (demo ? stopSailPointDemo("stopped") : startSailPointDemo())}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            {demo
              ? `Stop demo · ${formatRemaining(demo.until - now)} · ${demo.sent} sent`
              : "SailPoint demo"}
          </button>
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
      )}

      {section === "datadog" ? (
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
              {event.delivery.detail ? (
                <span className="mt-0.5 block text-zinc-500">{event.delivery.detail}</span>
              ) : null}
            </li>
          ))}
          {(state?.events.length ?? 0) === 0 ? (
            <li className="text-xs text-zinc-500">No events yet.</li>
          ) : null}
        </ul>
      </section>
      ) : null}

    </div>
  );
}

function DatadogMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749" />
    </svg>
  );
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
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
