"use client";

import { useState, type FormEvent } from "react";

import type { AskAnswer } from "@/lib/ask-tenant/tools";

export function AskTenantPanel({ tenant }: { tenant: string | null }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskAnswer | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ask-tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload = (await response.json().catch(() => ({}))) as AskAnswer & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? `Request failed (${response.status}).`);
      }
      setResult(payload);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "The question failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm font-medium text-zinc-800 dark:text-zinc-200" htmlFor="ask-tenant-question">
          Question
        </label>
        <textarea
          id="ask-tenant-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={500}
          placeholder={
            tenant
              ? `Ask about identities, access, audit events, or SAF activity on ${tenant}`
              : "Connect an ISC tenant, or ask about SAF events already stored here"
          }
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          type="submit"
          disabled={busy || question.trim().length === 0}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}

      {result ? (
        <pre
          className={`overflow-x-auto whitespace-pre-wrap rounded-md border p-3 text-sm ${
            result.refused
              ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
              : "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          }`}
        >
          {result.answer}
        </pre>
      ) : null}
    </div>
  );
}
