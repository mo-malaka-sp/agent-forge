import { EnvironmentDemoLaunch } from "@/components/environments/EnvironmentDemoLaunch";
import type { DiscoveredAgent } from "@/lib/environments/types";

export function EnvironmentReady({
  region,
  agents,
}: {
  region: string;
  agents: DiscoveredAgent[];
}) {
  const consoleUrl = `https://${region}.console.aws.amazon.com/bedrock-agentcore/home?region=${region}`;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-base font-semibold">Ready</h2>
      <p className="mt-1 text-sm text-zinc-600">
        AWS discovery finished. Open the resources, then launch a demo.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium" href={consoleUrl}>
          Open AWS AgentCore
        </a>
        {agents.map((agent) =>
          agent.iscUrl ? (
            <a
              key={agent.runtimeArn}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium"
              href={agent.iscUrl}
            >
              Open {agent.name} in ISC
            </a>
          ) : null,
        )}
      </div>
      <div className="mt-3">
        <EnvironmentDemoLaunch />
      </div>
    </section>
  );
}
