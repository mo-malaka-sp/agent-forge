import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { awsEnvironmentAdapter } from "@/lib/environments/aws/adapter";
import { environmentBuildVariables, startBuildBody } from "@/lib/environments/aws/codebuild";
import {
  commandsForPhase,
  executePreparation,
  loaderSetupCommands,
  SAF_LOADER_REVISION,
  secretFiles,
  type RunnerCommand,
  type RunnerDependencies,
} from "@/lib/environments/aws/runner";
import { initialPhases } from "@/lib/environments/phases";
import { redactSecrets } from "@/lib/environments/redact";
import { createEnvironmentService } from "@/lib/environments/service";
import { createMemoryEnvironmentStore, resetEnvironmentStoreForTests } from "@/lib/environments/store";
import type { DiscoveredAgent, EnvironmentRecord, EnvironmentRun } from "@/lib/environments/types";

const SECRET = "TARGET_CLIENT_SECRET=super-secret-value";
const previousProject = process.env.ENVIRONMENT_CODEBUILD_PROJECT;
const previousDryRun = process.env.ENVIRONMENT_RUNNER_DRY_RUN;

afterEach(() => {
  restore("ENVIRONMENT_CODEBUILD_PROJECT", previousProject);
  restore("ENVIRONMENT_RUNNER_DRY_RUN", previousDryRun);
  resetEnvironmentStoreForTests();
});

describe("AWS environment preparation", () => {
  it("rejects secret material and redacts embedded credentials", () => {
    assert.throws(
      () => awsEnvironmentAdapter.validateConnection(input({ secretRef: "AKIAIOSFODNN7EXAMPLE" })),
      /Do not paste a secret value/,
    );
    const redacted = redactSecrets("session AKIAIOSFODNN7EXAMPLE and ASIA1234567890ABCDEF");
    assert.equal(redacted.includes("AKIA"), false);
    assert.equal(redacted.includes("ASIA"), false);
    assert.equal(redactSecrets({ secretRef: "agentforge/isc", password: "hidden" }).password, "[redacted]");
  });

  it("prepares an existing account without deploying or deleting sources", async () => {
    const commands: string[] = [];
    const removed: string[] = [];
    const environment = record("existing");
    const run = await executePreparation(environment, pendingRun(environment), deps(commands, removed), "/tmp/loader");
    assert.equal(run.phases.find((phase) => phase.id === "deploy")?.status, "skipped");
    assert.equal(run.phases.every((phase) => phase.status === "succeeded" || phase.status === "skipped"), true);
    assert.equal(commands.some((command) => command.includes("deploy_agent.py")), false);
    assert.equal(commands.some((command) => command.includes("pre-import")), false);
    assert.equal(commands.some((command) => command.includes(SAF_LOADER_REVISION)), true);
    assert.equal(commands.some((command) => command.includes("aggregate")), true);
    assert.equal(commands.join("\n").includes("super-secret-value"), false);
    assert.deepEqual(removed, secretFiles(secretBody(), "/tmp/loader").map((file) => file.path));
    assert.equal(run.agents[0]?.name, "Existing Agent");
  });

  it("deploys FinBot for a new environment and retries only failed phases", async () => {
    const commands: string[] = [];
    let failAggregate = true;
    const environment = record("create");
    const failing = deps(commands, [], {
      async run(command) {
        commands.push(commandText(command));
        if (failAggregate && command.args.includes("aggregate") && !command.args.includes("pre-aggregate")) {
          throw new Error(`aggregate failed with ${SECRET}`);
        }
      },
      async listAgents() {
        return [];
      },
    });
    const first = await executePreparation(environment, pendingRun(environment), failing, "/tmp/loader");
    assert.equal(first.phases.find((phase) => phase.id === "deploy")?.status, "succeeded");
    assert.equal(first.phases.find((phase) => phase.id === "aggregate")?.status, "failed");
    assert.equal(first.error?.includes("super-secret-value"), false);
    assert.equal(commands.some((command) => command.includes("deploy_agent.py")), true);

    failAggregate = false;
    const repairedRun: EnvironmentRun = {
      ...first,
      repair: true,
      phases: first.phases.map((phase) =>
        phase.status === "failed" ? { ...phase, status: "pending", detail: "Retrying." } : phase,
      ),
    };
    const beforeRepair = commands.length;
    const second = await executePreparation(environment, repairedRun, failing, "/tmp/loader");
    const retried = commands.slice(beforeRepair);
    assert.equal(retried.some((command) => command.includes("deploy_agent.py")), false);
    assert.equal(retried.some((command) => command.includes(" saf-tenant import")), false);
    assert.equal(retried.some((command) => command.endsWith("saf-tenant aggregate --config-template sailpoint-only --env-file .env.agentforge")), true);
    assert.equal(second.phases.find((phase) => phase.id === "verify")?.status, "succeeded");
    assert.equal(second.agents[0]?.runtimeArn.includes("FinBot_Bedrock"), true);
  });

  it("keeps source deletion on the confirmed cleanup command", () => {
    const cleanupCommands = commandsForPhase("configure-isc", {
      mode: "existing",
      loaderDir: "/tmp/loader",
      cleanup: true,
    });
    assert.equal(cleanupCommands.some((command) => command.args.includes("pre-import")), true);
    assert.equal(loaderSetupCommands("/tmp/loader").some((command) => command.args.includes(SAF_LOADER_REVISION)), true);
    const normal = commandsForPhase("configure-isc", { mode: "existing", loaderDir: "/tmp/loader" });
    assert.equal(normal.some((command) => command.args.includes("pre-import")), false);
  });

  it("starts CodeBuild with references only", async () => {
    const store = createMemoryEnvironmentStore();
    const builds: Array<{ name: string; value: string }> = [];
    const service = createEnvironmentService(store, {
      async startBuild(input) {
        builds.push(...input.environmentVariables);
        return { id: "build-1" };
      },
    });
    process.env.ENVIRONMENT_CODEBUILD_PROJECT = "agentforge-environment-runner";
    delete process.env.ENVIRONMENT_RUNNER_DRY_RUN;
    const environment = await service.create(input({ mode: "existing" }));
    const run = await service.startRun(environment.id);
    assert.equal(run.codeBuildId, "build-1");
    assert.equal(run.phases.find((phase) => phase.id === "deploy")?.status, "skipped");
    const body = startBuildBody("agentforge-environment-runner", environmentBuildVariables(environment, run));
    assert.equal(body.includes("super-secret-value"), false);
    assert.equal(body.includes("PLAINTEXT"), true);
    assert.equal(builds.some((item) => item.name === "ENVIRONMENT_SECRET_REF"), true);
    assert.equal(builds.some((item) => item.value.includes("AKIA")), false);
    builds.length = 0;
    const cleanup = await service.requestCleanup(environment.id, "delete-sources");
    assert.match(cleanup.detail, /Cleanup build started/);
    assert.equal(builds.some((item) => item.name === "ENVIRONMENT_CLEANUP_CONFIRMED" && item.value === "delete-sources"), true);
    assert.equal(builds.some((item) => item.value.includes("super-secret-value")), false);
  });

  it("dry-runs both paths and repairs the incomplete phase", async () => {
    process.env.ENVIRONMENT_RUNNER_DRY_RUN = "1";
    delete process.env.ENVIRONMENT_CODEBUILD_PROJECT;
    const service = createEnvironmentService(createMemoryEnvironmentStore(), null, () => "2026-10-18T00:00:00.000Z");
    const created = await service.create(input({ mode: "create", name: "FinBot" }));
    const createdRun = await service.startRun(created.id);
    assert.equal(createdRun.phases.find((phase) => phase.id === "deploy")?.status, "succeeded");
    assert.equal(createdRun.phases.every((phase) => phase.status === "succeeded"), true);

    const existing = await service.create(input({ mode: "existing", name: "Connected" }));
    const existingRun = await service.startRun(existing.id);
    assert.equal(existingRun.phases.find((phase) => phase.id === "deploy")?.status, "skipped");
    assert.equal(existingRun.phases.find((phase) => phase.id === "verify")?.status, "failed");
    const repaired = await service.startRun(existing.id, true);
    assert.equal(repaired.repair, true);
    assert.equal(repaired.phases.find((phase) => phase.id === "validate")?.detail, existingRun.phases[0]?.detail);
    assert.equal(repaired.phases.find((phase) => phase.id === "verify")?.status, "failed");
    assert.equal((await service.requestCleanup(existing.id, "no")).accepted, false);
    assert.match((await service.requestCleanup(existing.id, "delete-sources")).detail, /No sources or AWS resources were deleted/);
    const listed = await service.list();
    const loaded = await service.get(existing.id);
    assert.equal(listed.length, 2);
    assert.equal(loaded.name, "Connected");
    assert.equal((await service.verify(created.id)).ready, true);
    assert.equal((await service.discover(existing.id)).length, 0);
  });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    provider: "aws" as const,
    name: "Demo AWS",
    mode: "existing" as const,
    region: "us-east-1",
    roleArn: "arn:aws:iam::123456789012:role/AgentForgeEnvironment",
    secretRef: "agentforge/isc",
    reviewConfirmed: true,
    ...overrides,
  };
}

function record(mode: EnvironmentRecord["mode"]): EnvironmentRecord {
  return {
    id: "env-1",
    provider: "aws",
    name: "Demo AWS",
    mode,
    region: "us-east-1",
    roleArn: "arn:aws:iam::123456789012:role/AgentForgeEnvironment",
    secretRef: "agentforge/isc",
    accountId: "123456789012",
    iscSourceName: "AWS IAM - CAM SE",
    reviewConfirmed: true,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

function pendingRun(environment: EnvironmentRecord): EnvironmentRun {
  return {
    id: "run-1",
    environmentId: environment.id,
    repair: false,
    phases: initialPhases(environment.mode, "2026-10-18T00:00:00.000Z"),
    agents: [],
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

function secretBody(): string {
  return JSON.stringify({
    TARGET_API_URL: "https://tenant.api.identitynow-demo.com",
    TARGET_CLIENT_ID: "client-id",
    TARGET_CLIENT_SECRET: "super-secret-value",
    TARGET_OWNER_IDENTITY: "Demo Owner",
    sourceCredentials: { aws: { token: "connector-secret" } },
  });
}

function deps(
  commands: string[],
  removed: string[] = [],
  overrides: Partial<RunnerDependencies> = {},
): RunnerDependencies {
  const agents: DiscoveredAgent[] = [{ name: "Existing Agent", runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/existing" }];
  return {
    async assumeRole() {},
    async readSecret() {
      return secretBody();
    },
    async run(command) {
      commands.push(commandText(command));
    },
    async listAgents() {
      return agents;
    },
    async writeFiles() {},
    async removeFiles(paths) {
      removed.push(...paths);
    },
    ...overrides,
  };
}

function commandText(command: RunnerCommand): string {
  return [command.command, ...command.args].join(" ");
}

function restore(name: "ENVIRONMENT_CODEBUILD_PROJECT" | "ENVIRONMENT_RUNNER_DRY_RUN", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
