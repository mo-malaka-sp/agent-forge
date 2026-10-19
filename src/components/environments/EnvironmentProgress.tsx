import type { PhaseState } from "@/lib/environments/types";

const LABELS: Record<PhaseState["id"], string> = {
  validate: "Validate",
  deploy: "Deploy",
  "configure-isc": "Configure ISC",
  aggregate: "Aggregate",
  verify: "Verify",
};

export function EnvironmentProgress({ phases }: { phases: PhaseState[] }) {
  return (
    <ol className="space-y-2">
      {phases.map((phase) => (
        <li key={phase.id} className="rounded-md border border-zinc-200 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-3">
            <strong>{LABELS[phase.id]}</strong>
            <span className="text-xs uppercase tracking-wide text-zinc-500">{phase.status}</span>
          </div>
          <p className="mt-1 text-zinc-600">{phase.detail}</p>
        </li>
      ))}
    </ol>
  );
}
