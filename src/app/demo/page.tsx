import { Suspense } from "react";

import { DemoOrchestratorPanel } from "@/components/DemoOrchestratorPanel";

function DemoOrchestratorFallback() {
  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-8 text-center text-sm text-zinc-500 dark:border-indigo-900 dark:bg-indigo-950/20">
      Loading demo orchestrator...
    </div>
  );
}

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ phase?: string }>;
}) {
  const { phase } = await searchParams;
  const setup = phase === "setup" || phase === "connect" || phase === "bootstrap";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {setup ? "Connect one ISC tenant" : "Govern AI Agents"}
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {setup
            ? "Step 1 connects the tenant. Step 2 bootstraps the demo sources."
            : "Aggregate agent access, then run governance and enforcement."}
        </p>
      </section>
      <Suspense fallback={<DemoOrchestratorFallback />}>
        <DemoOrchestratorPanel />
      </Suspense>
    </div>
  );
}
