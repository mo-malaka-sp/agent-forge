"use client";

import { useState, type FormEvent } from "react";

export function EnvironmentCleanup({ id }: { id: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/environments/${id}/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: form.get("confirm") }),
      });
      const body = (await response.json()) as { detail?: string; error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? body.detail ?? "Cleanup was not accepted.");
      }
      setMessage(body.detail ?? "Cleanup confirmation recorded.");
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : "Cleanup was not accepted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rounded-lg border border-zinc-200 bg-white p-4 text-sm" onSubmit={onSubmit}>
      <h2 className="text-base font-semibold">Remove ISC sources</h2>
      <p className="mt-1 text-zinc-600">
        Source deletion is separate from preparation. Type delete-sources to confirm. This page does
        not delete AWS resources.
      </p>
      <input
        name="confirm"
        aria-label="Cleanup confirmation"
        className="mt-3 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono"
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-3 rounded-md border border-zinc-300 px-3 py-2 font-medium"
      >
        {busy ? "Confirming…" : "Confirm cleanup"}
      </button>
      {message ? <p className="mt-3 text-zinc-700">{message}</p> : null}
      {error ? (
        <p className="mt-3 rounded-md bg-red-50 p-3 text-red-800" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
