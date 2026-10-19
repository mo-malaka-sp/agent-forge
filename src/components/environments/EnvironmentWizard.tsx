"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function EnvironmentWizard() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/environments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "aws",
          name: form.get("name"),
          mode: form.get("mode"),
          region: form.get("region"),
          roleArn: form.get("roleArn"),
          secretRef: form.get("secretRef"),
          iscSourceName: form.get("iscSourceName"),
          reviewConfirmed: form.get("reviewConfirmed") === "on",
        }),
      });
      const body = (await response.json()) as { error?: string; environment?: { id: string } };
      if (!response.ok || !body.environment) {
        throw new Error(body.error ?? "Could not save the environment.");
      }
      router.push(`/environments/${body.environment.id}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not save the environment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4" onSubmit={onSubmit}>
      <div>
        <h2 className="text-base font-semibold">Connect AWS</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Use an existing account, or create the synthetic FinBot AgentCore demo. AgentForge stores
          the role ARN and secret reference only.
        </p>
      </div>
      {error ? (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </p>
      ) : null}
      <label className="block text-sm">
        Environment name
        <input name="name" required className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2" />
      </label>
      <fieldset className="space-y-2 text-sm">
        <legend className="font-medium">Path</legend>
        <label className="flex gap-2">
          <input type="radio" name="mode" value="existing" defaultChecked />
          Existing AWS environment
        </label>
        <label className="flex gap-2">
          <input type="radio" name="mode" value="create" />
          Create FinBot demo environment
        </label>
      </fieldset>
      <label className="block text-sm">
        Region
        <input
          name="region"
          defaultValue="us-east-1"
          required
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        Cross-account role ARN
        <input
          name="roleArn"
          required
          placeholder="arn:aws:iam::123456789012:role/AgentForgeEnvironment"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
      </label>
      <label className="block text-sm">
        Secrets Manager reference
        <input
          name="secretRef"
          required
          placeholder="agentforge/aws-environment"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
        />
      </label>
      <label className="block text-sm">
        ISC source name
        <input
          name="iscSourceName"
          defaultValue="AWS IAM - CAM SE"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2"
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input name="reviewConfirmed" type="checkbox" required className="mt-1" />
        <span>
          I reviewed this connection. Creating a demo environment deploys synthetic FinBot resources.
          Cleanup stays a separate confirmation.
        </span>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white"
      >
        {busy ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
