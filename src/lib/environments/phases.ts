import type {
  DiscoveredAgent,
  EnvironmentRecord,
  EnvironmentRun,
  PhaseId,
  PhaseState,
  PhaseStatus,
} from "@/lib/environments/types";
import { PHASES } from "@/lib/environments/types";

export function initialPhases(mode: EnvironmentRecord["mode"], now = new Date().toISOString()): PhaseState[] {
  return PHASES.map((id) => ({
    id,
    status: id === "deploy" && mode === "existing" ? "skipped" : "pending",
    detail: id === "deploy" && mode === "existing" ? "Existing environment." : "Waiting.",
    updatedAt: now,
  }));
}

export function incompletePhases(run: EnvironmentRun): PhaseState[] {
  return run.phases.filter((phase) => phase.status === "pending" || phase.status === "failed");
}

export function applyPhaseResult(
  run: EnvironmentRun,
  phaseId: PhaseId,
  status: PhaseStatus,
  detail: string,
  extra: Partial<Pick<EnvironmentRun, "agents" | "iscSourceId" | "error" | "codeBuildId">> = {},
  now = new Date().toISOString(),
): EnvironmentRun {
  return {
    ...run,
    ...extra,
    error: status === "failed" ? detail : extra.error,
    updatedAt: now,
    phases: run.phases.map((phase) =>
      phase.id === phaseId ? { ...phase, status, detail, updatedAt: now } : phase,
    ),
  };
}

export function phaseDetail(
  environment: EnvironmentRecord,
  phaseId: PhaseId,
  agents: DiscoveredAgent[],
): string {
  switch (phaseId) {
    case "validate":
      return `Validated account ${environment.accountId} in ${environment.region}.`;
    case "deploy":
      return environment.mode === "create"
        ? "FinBot AgentCore runtime deployment finished."
        : "Existing environment.";
    case "configure-isc":
      return `Configured ISC source ${environment.iscSourceName}.`;
    case "aggregate":
      return "Aggregated aws:iam and aws:bedrockagentcore.";
    case "verify":
      return agents.length
        ? `Discovered ${agents.length} AgentCore agent${agents.length === 1 ? "" : "s"}.`
        : "No AgentCore agents were discovered.";
  }
}

export function isRunReady(run: EnvironmentRun): boolean {
  return run.phases.every((phase) => phase.status === "succeeded" || phase.status === "skipped");
}
