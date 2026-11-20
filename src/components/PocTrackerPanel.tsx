"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { WebhookLogList, type WebhookLogEntryView } from "@/components/WebhookLogList";

type Tracker = {
  asanaTokenSource: "desk" | "environment" | "missing";
  slackTokenSource: "saved" | "environment" | "missing";
  projectName: string;
  projectGid: string;
  webhookGid: string;
  channelId: string;
  log: WebhookLogEntryView[];
};

type Storage = {
  storage: "dynamodb" | "local";
  storedAt: string;
};

const POLL_INTERVAL_MS = 4000;

export function PocTrackerPanel() {
  const [slackBotToken, setSlackBotToken] = useState("");
  const [projectName, setProjectName] = useState("POC Gateway - Request Management");
  const [channelId, setChannelId] = useState("");
  const [tracker, setTracker] = useState<Tracker | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const response = await fetch("/api/poc-tracker");
        const body = (await response.json()) as { tracker?: Tracker; storage?: Storage; error?: string };
        if (cancelled) {
          return;
        }
        if (body.tracker) {
          setTracker(body.tracker);
          if (!loaded.current) {
            loaded.current = true;
            setProjectName(body.tracker.projectName);
            setChannelId(body.tracker.channelId);
          }
        }
        setStorage(body.storage ?? null);
        if (!response.ok && body.error) {
          setError(body.error);
        }
      } catch {
        // The next poll retries.
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function connect() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch("/api/poc-tracker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackBotToken, projectName, channelId }),
      });
      const body = (await response.json()) as {
        tracker?: Tracker;
        webhookError?: string;
        storage?: Storage;
        error?: string;
      };
      if (body.tracker) {
        setTracker(body.tracker);
        setSlackBotToken("");
      }
      setStorage(body.storage ?? null);
      if (body.webhookError || body.error) {
        setError(body.webhookError || body.error || "Connect failed.");
      } else if (response.ok) {
        setMessage(`Connected to ${body.tracker?.projectName ?? projectName}. Move a task to see the log update.`);
      }
    } catch {
      setError("Connect failed.");
    } finally {
      setBusy(false);
    }
  }

  const slackNote =
    tracker?.slackTokenSource === "saved"
      ? "Using the Slack bot token saved here."
      : tracker?.slackTokenSource === "environment"
        ? "Using SLACK_BOT_TOKEN from the server environment."
        : "No Slack bot token yet. Save one here, or set SLACK_BOT_TOKEN.";

  return (
    <section className="space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Connection</h2>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          This is a separate Asana project from{" "}
          <Link href="/readonly-account" className="underline underline-offset-2">
            SAF TestDrive Accounts
          </Link>
          , in the same Asana workspace. It uses the same Asana access token. A move into Active Provisioning,
          Implemented / Live, Completed, or Rejected posts a reply in the Slack thread stored on the task.
        </p>
      </div>
      <p className="text-xs">
        Asana access token:{" "}
        {tracker?.asanaTokenSource === "desk" ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            saved on{" "}
            <Link href="/readonly-account" className="underline underline-offset-2">
              SAF TestDrive Accounts
            </Link>
          </span>
        ) : tracker?.asanaTokenSource === "environment" ? (
          <span className="text-emerald-700 dark:text-emerald-300">set as ASANA_ACCESS_TOKEN on the server</span>
        ) : (
          <span className="text-red-700 dark:text-red-300">
            not set. Save it on{" "}
            <Link href="/readonly-account" className="underline underline-offset-2">
              SAF TestDrive Accounts
            </Link>{" "}
            first, or set ASANA_ACCESS_TOKEN.
          </span>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Asana project" value={projectName} onChange={setProjectName} />
        <Field
          label="Slack bot token"
          type="password"
          value={slackBotToken}
          placeholder={tracker?.slackTokenSource === "saved" ? "Saved. Enter a new token to replace it." : "Optional"}
          onChange={setSlackBotToken}
        />
        <Field label="Slack channel" value={channelId} placeholder="C0CK03K8QF3" onChange={setChannelId} />
      </div>
      <p className="text-xs text-zinc-500">{slackNote}</p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void connect()}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium disabled:opacity-50 dark:border-zinc-700"
      >
        {busy ? "Connecting…" : "Save and connect"}
      </button>
      {message ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="text-xs text-red-700 dark:text-red-300">{error}</p> : null}
      {storage?.storage === "dynamodb" ? (
        <p className="text-xs text-zinc-500">Saved to DynamoDB table {storage.storedAt}. The connection survives deploys.</p>
      ) : null}
      {storage?.storage === "local" ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          This server keeps the connection in a local file, which a deploy erases. Set SAF_POC_TABLE_NAME in Amplify and
          redeploy.
        </p>
      ) : null}
      {tracker?.webhookGid ? (
        <p className="text-xs text-zinc-500">
          Webhook {tracker.webhookGid} on project {tracker.projectGid || tracker.projectName}. Replies go to{" "}
          {tracker.channelId}.
        </p>
      ) : null}
      <WebhookLogList
        entries={tracker?.log ?? []}
        empty="No webhook deliveries yet. Save and connect, then move a task in the POC Tracker project."
      />
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
    </label>
  );
}
