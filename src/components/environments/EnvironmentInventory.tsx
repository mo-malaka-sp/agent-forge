import type { DiscoveredAgent } from "@/lib/environments/types";

export function EnvironmentInventory({ agents }: { agents: DiscoveredAgent[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-base font-semibold">Discovered agents</h2>
      {agents.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-600">Agents appear here after AWS discovery.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {agents.map((agent) => (
            <li key={agent.runtimeArn} className="text-sm">
              <p className="font-medium">{agent.name}</p>
              <p className="break-all font-mono text-xs text-zinc-500">{agent.runtimeArn}</p>
              {agent.iscUrl ? (
                <a className="text-sm font-medium text-blue-700" href={agent.iscUrl}>
                  Open in ISC
                </a>
              ) : (
                <p className="text-xs text-zinc-500">Waiting for the ISC agent link.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
