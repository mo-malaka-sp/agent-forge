export const ENVIRONMENT_PROVIDERS = ["aws", "snowflake", "databricks"] as const;
export type EnvironmentProvider = (typeof ENVIRONMENT_PROVIDERS)[number];

export const ENVIRONMENT_MODES = ["existing", "create"] as const;
export type EnvironmentMode = (typeof ENVIRONMENT_MODES)[number];

export const PHASES = ["validate", "deploy", "configure-isc", "aggregate", "verify"] as const;
export type PhaseId = (typeof PHASES)[number];

export type PhaseStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export interface PhaseState {
  id: PhaseId;
  status: PhaseStatus;
  detail: string;
  updatedAt: string;
}

export interface DiscoveredAgent {
  name: string;
  runtimeArn: string;
  gatewayArn?: string;
  iscAgentId?: string;
  iscUrl?: string;
}

export interface EnvironmentRecord {
  id: string;
  provider: EnvironmentProvider;
  name: string;
  mode: EnvironmentMode;
  region: string;
  roleArn: string;
  secretRef: string;
  accountId: string;
  iscSourceName: string;
  reviewConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentRun {
  id: string;
  environmentId: string;
  repair: boolean;
  codeBuildId?: string;
  phases: PhaseState[];
  agents: DiscoveredAgent[];
  iscSourceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnvironmentInput {
  provider: EnvironmentProvider;
  name: string;
  mode: EnvironmentMode;
  region: string;
  roleArn: string;
  secretRef: string;
  iscSourceName?: string;
  reviewConfirmed: boolean;
}
