import { nanoid } from "nanoid";

import { awsEnvironmentAdapter } from "@/lib/environments/aws/adapter";
import {
  codeBuildProjectName,
  createAwsBuildStarter,
  environmentBuildVariables,
  type BuildStarter,
} from "@/lib/environments/aws/codebuild";
import { incompletePhases, initialPhases, isRunReady } from "@/lib/environments/phases";
import { redactSecrets } from "@/lib/environments/redact";
import { getEnvironmentStore, type EnvironmentStore } from "@/lib/environments/store";
import type {
  CreateEnvironmentInput,
  DiscoveredAgent,
  EnvironmentRecord,
  EnvironmentRun,
} from "@/lib/environments/types";

export interface EnvironmentService {
  create(input: CreateEnvironmentInput): Promise<EnvironmentRecord>;
  list(): Promise<EnvironmentRecord[]>;
  get(id: string): Promise<EnvironmentRecord>;
  validate(id: string): Promise<EnvironmentRecord>;
  startRun(id: string, repair?: boolean): Promise<EnvironmentRun>;
  getRun(environmentId: string, runId: string): Promise<EnvironmentRun>;
  latestRun(environmentId: string): Promise<EnvironmentRun | null>;
  discover(id: string): Promise<DiscoveredAgent[]>;
  verify(id: string): Promise<{ ready: boolean; detail: string; agents: DiscoveredAgent[] }>;
  requestCleanup(id: string, confirmation: string): Promise<{ accepted: boolean; detail: string }>;
}

export function createEnvironmentService(
  store: EnvironmentStore = getEnvironmentStore(),
  builds: BuildStarter | null = null,
  now = () => new Date().toISOString(),
): EnvironmentService {
  async function requireEnvironment(id: string): Promise<EnvironmentRecord> {
    const environment = await store.getEnvironment(id);
    if (!environment) {
      throw new Error("Environment not found.");
    }
    return environment;
  }

  return {
    async create(input) {
      const connection = awsEnvironmentAdapter.validateConnection(input);
      const timestamp = now();
      const record: EnvironmentRecord = {
        id: nanoid(12),
        provider: "aws",
        name: input.name.trim(),
        mode: input.mode,
        region: connection.region,
        roleArn: connection.roleArn,
        secretRef: connection.secretRef,
        accountId: connection.accountId,
        iscSourceName: input.iscSourceName?.trim() || "AWS IAM - CAM SE",
        reviewConfirmed: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.saveEnvironment(record);
      return redactSecrets(record);
    },
    async list() {
      const records = await store.listEnvironments();
      return redactSecrets(records).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    async get(id) {
      return redactSecrets(await requireEnvironment(id));
    },
    async validate(id) {
      const environment = await requireEnvironment(id);
      awsEnvironmentAdapter.validateConnection({ ...environment, reviewConfirmed: true });
      const updated = { ...environment, updatedAt: now() };
      await store.saveEnvironment(updated);
      return redactSecrets(updated);
    },
    async startRun(id, repair = false) {
      const environment = await requireEnvironment(id);
      const previous = await latest(store, id);
      const timestamp = now();
      let run: EnvironmentRun = {
        id: nanoid(12),
        environmentId: id,
        repair,
        phases: repair && previous ? repairPhases(previous, timestamp) : initialPhases(environment.mode, timestamp),
        agents: repair && previous ? previous.agents : [],
        iscSourceId: repair ? previous?.iscSourceId : undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const project = codeBuildProjectName();
      if (project) {
        const starter = builds ?? createAwsBuildStarter();
        const build = await starter.startBuild({
          projectName: project,
          environmentVariables: environmentBuildVariables(environment, run),
        });
        run = { ...run, codeBuildId: build.id };
      } else if (process.env.ENVIRONMENT_RUNNER_DRY_RUN === "1") {
        run = dryRun(environment, run, timestamp);
      } else {
        throw new Error("Set ENVIRONMENT_CODEBUILD_PROJECT before starting preparation.");
      }
      await store.saveRun(run);
      return redactSecrets(run);
    },
    async getRun(environmentId, runId) {
      const run = await store.getRun(environmentId, runId);
      if (!run) {
        throw new Error("Preparation run not found.");
      }
      return redactSecrets(run);
    },
    latestRun(id) {
      return latest(store, id);
    },
    async discover(id) {
      const environment = await requireEnvironment(id);
      const run = await latest(store, id);
      return redactSecrets(run ? awsEnvironmentAdapter.discoverAgents(environment, run) : []);
    },
    async verify(id) {
      const agents = await this.discover(id);
      return { ...awsEnvironmentAdapter.verifyInIsc(agents), agents };
    },
    async requestCleanup(id, confirmation) {
      const environment = await requireEnvironment(id);
      if (confirmation !== "delete-sources") {
        return {
          accepted: false,
          detail: "Cleanup requires a separate delete-sources confirmation.",
        };
      }
      const project = codeBuildProjectName();
      if (!project) {
        return {
          accepted: true,
          detail: "Cleanup confirmation recorded. No sources or AWS resources were deleted.",
        };
      }
      const timestamp = now();
      const run: EnvironmentRun = {
        id: nanoid(12),
        environmentId: id,
        repair: false,
        phases: initialPhases(environment.mode, timestamp).map((phase) => ({
          ...phase,
          status: "skipped",
          detail: "Source cleanup is separate from preparation.",
        })),
        agents: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const starter = builds ?? createAwsBuildStarter();
      const build = await starter.startBuild({
        projectName: project,
        environmentVariables: environmentBuildVariables(environment, run, [
          { name: "ENVIRONMENT_CLEANUP_CONFIRMED", value: "delete-sources" },
        ]),
      });
      await store.saveRun({ ...run, codeBuildId: build.id });
      return {
        accepted: true,
        detail: "Cleanup build started. Preparation does not delete sources.",
      };
    },
  };
}

async function latest(store: EnvironmentStore, environmentId: string): Promise<EnvironmentRun | null> {
  const runs = await store.listRuns(environmentId);
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function repairPhases(previous: EnvironmentRun, now: string): EnvironmentRun["phases"] {
  return previous.phases.map((phase) =>
    phase.status === "succeeded" || phase.status === "skipped"
      ? phase
      : { ...phase, status: "pending", detail: "Retrying.", updatedAt: now },
  );
}

function dryRun(environment: EnvironmentRecord, run: EnvironmentRun, now: string): EnvironmentRun {
  const agents = awsEnvironmentAdapter.discoverAgents(environment, run);
  return {
    ...run,
    agents,
    updatedAt: now,
    phases: run.phases.map((phase) =>
      incompletePhases({ ...run, phases: [phase] }).length === 0
        ? phase
        : {
            ...phase,
            status: phase.id === "verify" && agents.length === 0 ? "failed" : "succeeded",
            detail:
              phase.id === "verify" && agents.length === 0
                ? "No AgentCore agents were discovered."
                : `${phase.id} completed in local dry run.`,
            updatedAt: now,
          },
    ),
  };
}

export function runReady(run: EnvironmentRun): boolean {
  return isRunReady(run);
}
