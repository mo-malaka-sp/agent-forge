import { EnvironmentDetail } from "@/components/environments/EnvironmentDetail";
import { createEnvironmentService } from "@/lib/environments/service";
import type { DiscoveredAgent, EnvironmentRecord, EnvironmentRun } from "@/lib/environments/types";

export default async function EnvironmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let environment: EnvironmentRecord | null = null;
  let run: EnvironmentRun | null = null;
  let agents: DiscoveredAgent[] = [];
  let loadError: string | null = null;
  try {
    const service = createEnvironmentService();
    environment = await service.get(id);
    run = await service.latestRun(id);
    agents = await service.discover(id);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Could not load the environment.";
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8">
      <EnvironmentDetail
        id={id}
        initialEnvironment={environment}
        initialRun={run}
        initialAgents={agents}
        loadError={loadError}
      />
    </main>
  );
}
