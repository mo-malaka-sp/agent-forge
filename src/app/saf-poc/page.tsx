import { SafPocPanel } from "@/components/SafPocPanel";
import { safPocResponse } from "@/lib/saf-poc/http";
import { listTenantAgents, type TenantAgent } from "@/lib/saf-poc/tenant-agents";
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
  let agents: TenantAgent[] = [];
  let agentsError: string | null = null;
  try {
    agents = await listTenantAgents();
  } catch (error) {
    agentsError = error instanceof Error ? error.message : "Could not load tenant agents.";
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          SailPoint Agentic Fabric event tests
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Test 1 proves a real CAEP event can cross the SailPoint receiver and workflow
          bus. Test 2 independently proves that an Agentic Fabric webhook reaches
          Datadog. Each section names exactly what its buttons prove.
        </p>
      </section>
      <SafPocPanel
        initialState={initialState}
        initialError={initialError}
        agents={agents}
        agentsError={agentsError}
      />
    </div>
  );
}
