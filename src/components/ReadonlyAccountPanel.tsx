"use client";

import { useState } from "react";

import type {
  ActivationResult,
  CreateResult,
  SetupResult,
  StepStatus,
} from "@/lib/readonly-account/tenant";

const POLL_INTERVAL_MS = 4000;
const MAX_POLLS = 30;

const STATUS_STYLES: Record<StepStatus, string> = {
  found: "text-zinc-600 dark:text-zinc-300",
  ok: "text-emerald-700 dark:text-emerald-300",
  created: "text-emerald-700 dark:text-emerald-300",
  updated: "text-amber-700 dark:text-amber-300",
  pending: "text-zinc-500",
  failed: "text-red-700 dark:text-red-300",
};

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok && !("steps" in (payload as object))) {
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  return payload;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ReadonlyAccountPanel() {
  const [busy, setBusy] = useState<"setup" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupResult | null>(null);
  const [created, setCreated] = useState<CreateResult | null>(null);
  const [activation, setActivation] = useState<ActivationResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [redirectEmail, setRedirectEmail] = useState("");

  async function runSetup() {
    setBusy("setup");
    setError(null);
    try {
      setSetup(await post<SetupResult>("/api/readonly-account/setup"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runCreate() {
    setBusy("create");
    setError(null);
    setCreated(null);
    setActivation(null);
    setTimedOut(false);
    try {
      const result = await post<CreateResult>("/api/readonly-account/create", {
        email: redirectEmail.trim(),
      });
      setCreated(result);
      let processed = false;
      let passwordSet = false;
      let passwordError: string | null = null;
      let inviteSent = false;
      let inviteError: string | null = null;
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await wait(POLL_INTERVAL_MS);
        const next: ActivationResult = await post<ActivationResult>("/api/readonly-account/activate", {
          ...result.refs,
          userId: result.user.id,
          taskId: result.taskId,
          password: result.user.password,
          passwordSet,
          passwordError,
          redirectEmail: result.emailRedirect ?? "",
          inviteSent,
          inviteError,
          attempt,
          processed,
        });
        processed = next.processed;
        passwordSet = next.passwordSet;
        passwordError = next.passwordError;
        inviteSent = next.inviteSent;
        inviteError = next.inviteError;
        setActivation(next);
        if (next.done) {
          return;
        }
      }
      setTimedOut(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Account creation failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">1. Set up tenant</h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Makes sure the active lifecycle state and the ReadOnly-Admins role exist. Safe to
              run again.
            </p>
          </div>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void runSetup()}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
          >
            {busy === "setup" ? "Setting up…" : "Set up tenant"}
          </button>
          {setup ? (
            <ul className="space-y-1 text-xs">
              {setup.steps.map((step) => (
                <li key={`${step.label}-${step.status}`} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{step.label}</span>
                  <span className={STATUS_STYLES[step.status]}>{step.status}</span>
                  <span className="break-all text-zinc-500">{step.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="space-y-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">2. Create test account</h2>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Adds one unique user, then waits until the identity is active and has the role.
            </p>
          </div>
          <label className="block text-xs">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">
              Send tenant emails to
            </span>
            <input
              type="email"
              value={redirectEmail}
              onChange={(event) => setRedirectEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={busy !== null}
              className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900"
            />
            <span className="mt-1 block text-zinc-500">
              Saves this as the Email Templates test address. Every email from the tenant goes
              there until you switch Email Templates back to Intended Recipients.
            </span>
          </label>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void runCreate()}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {busy === "create" ? "Working…" : "Create test account"}
          </button>
          {created ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-zinc-500">Sign-in id</dt>
              <dd className="font-mono">{activation?.alias ?? created.user.id}</dd>
              <dt className="text-zinc-500">Name</dt>
              <dd>{created.user.name}</dd>
              <dt className="text-zinc-500">Email</dt>
              <dd className="break-all font-mono">{created.user.email}</dd>
              <dt className="text-zinc-500">Tenant emails</dt>
              <dd className="break-all font-mono">{created.emailRedirect ?? "unchanged"}</dd>
              <dt className="text-zinc-500">Password</dt>
              <dd className="font-mono">
                {activation?.passwordError ? "not set" : created.user.password}
              </dd>
              <dt className="text-zinc-500">Account task</dt>
              <dd className="break-all font-mono">{created.taskId ?? "not returned"}</dd>
              <dt className="text-zinc-500">Lifecycle</dt>
              <dd>{activation?.lifecycleState ?? "pending"}</dd>
              <dt className="text-zinc-500">IdentityNow account</dt>
              <dd>
                {activation?.accountEnabled == null
                  ? "pending"
                  : activation.accountEnabled
                    ? "enabled"
                    : "disabled"}
              </dd>
              <dt className="text-zinc-500">ReadOnly-Admins</dt>
              <dd>{activation?.roleAssigned ? "assigned" : "not yet"}</dd>
            </dl>
          ) : null}
          {activation ? (
            <p
              className={`text-xs ${activation.done ? "text-emerald-700 dark:text-emerald-300" : "text-zinc-600 dark:text-zinc-400"}`}
            >
              {activation.detail}
            </p>
          ) : null}
          {timedOut ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Still not complete after two minutes. Check the identity in the tenant.
            </p>
          ) : null}
          {activation?.done && !activation.passwordError ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Sign in with the username and password shown above.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
