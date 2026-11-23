import { SafPocPanel } from "@/components/SafPocPanel";
import { TenantPicker } from "@/components/TenantPicker";
import { resolveFeatureRuntime, type TenantFeature } from "@/lib/isc/feature-tenant";
import { runWithIscRuntimeAsync } from "@/lib/isc/runtime-config";
import { safPocResponse } from "@/lib/saf-poc/http";
import { listTenantAgents, type TenantAgent } from "@/lib/saf-poc/tenant-agents";
import { getRequestBaseUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

export default async function SafPocPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section: requested } = await searchParams;
  const section =
    requested === "datadog" ? "datadog" : requested === "endpoint" ? "endpoint" : "caep";
  // Each section reads the tenant bound to it, so CAEP, Datadog and Endpoint can differ.
  const feature: TenantFeature = section;
  const baseUrl = await getRequestBaseUrl();

  const loaded = await runWithIscRuntimeAsync(await resolveFeatureRuntime(feature), async () => {
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
    return { initialState, initialError, agents, agentsError };
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {section === "caep"
            ? "CAEP Event Bus"
            : section === "endpoint"
              ? "Endpoint Agent Risk"
              : "Datadog Security Signals"}
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          {section === "caep"
            ? "Send a signed CAEP risk event into SailPoint and confirm the workflow email."
            : section === "endpoint"
              ? "Sentinel endpoint agents only. Plaintext credentials move the risk band."
              : "Stream agent risk into Datadog and open the signals that link back to SailPoint."}
        </p>
      </section>
      <TenantPicker
        feature={feature}
        label={
          section === "caep"
            ? "SailPoint tenant for the CAEP event bus"
            : section === "endpoint"
              ? "SailPoint tenant for endpoint agent risk"
              : "SailPoint tenant for Datadog signals"
        }
      />
      <SafPocPanel
        section={section}
        initialState={loaded.initialState}
        initialError={loaded.initialError}
        agents={loaded.agents}
        agentsError={loaded.agentsError}
      />
    </div>
  );
}
