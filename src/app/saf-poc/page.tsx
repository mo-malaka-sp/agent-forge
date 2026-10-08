import { SafPocPanel } from "@/components/SafPocPanel";
import { findAgents } from "@/lib/db/store";
import { safPocResponse } from "@/lib/saf-poc/http";
import { getRequestBaseUrl } from "@/lib/url";

export default async function SafPocPage() {
  const baseUrl = await getRequestBaseUrl();
  let initialState = null;
  let initialError: string | null = null;
  try {
    initialState = await safPocResponse(baseUrl);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Could not load SAF POC.";
  }
  const agents = findAgents({ page: 1, limit: 100 }).rows.map((agent) => {
    let riskLevel = "";
    try {
      const metadata = JSON.parse(agent.metadata) as Record<string, unknown>;
      riskLevel = typeof metadata.risk_level === "string" ? metadata.risk_level : "";
    } catch {
      riskLevel = "";
    }
    return { id: agent.id, name: agent.name, riskLevel };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          SAF event bus and Datadog
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Prove a CAEP risk-level change can email you through SailPoint Workflows, and
          that a fire-and-forget risk event lands in Datadog. Both run from this
          deployment — no tunnel and no second process.
        </p>
      </section>
      <SafPocPanel
        initialState={initialState}
        initialError={initialError}
        agents={agents}
      />
    </div>
  );
}
