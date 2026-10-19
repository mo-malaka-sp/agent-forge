import { awsEnvironmentAdapter } from "@/lib/environments/aws/adapter";
import { applyPhaseResult, incompletePhases, phaseDetail } from "@/lib/environments/phases";
import { redactSecrets } from "@/lib/environments/redact";
import type {
  DiscoveredAgent,
  EnvironmentMode,
  EnvironmentRecord,
  EnvironmentRun,
  PhaseId,
} from "@/lib/environments/types";

export const SAF_LOADER_REPOSITORY = "https://github.com/sailpoint-se/tool-saf-config-loader.git";
// Canonical main revision after SAF Tenant Configuration guide v20 (template clone CLI).
export const SAF_LOADER_REVISION = "197d7106d1091cef5f8c5647370a5cfc3d56d5e1";
export const SAF_CONFIG_TEMPLATE = "sailpoint-only";

const SECRET_FIELDS = [
  "TARGET_API_URL",
  "TARGET_CLIENT_ID",
  "TARGET_CLIENT_SECRET",
  "TARGET_OWNER_IDENTITY",
] as const;

export interface RunnerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export interface RunnerDependencies {
  assumeRole(roleArn: string): Promise<void>;
  readSecret(secretRef: string): Promise<string>;
  run(command: RunnerCommand): Promise<void>;
  listAgents(region: string, accountId: string): Promise<DiscoveredAgent[]>;
  writeFiles(files: Array<{ path: string; contents: string }>): Promise<void>;
  removeFiles(paths: string[]): Promise<void>;
}

export function loaderSetupCommands(loaderDir: string): RunnerCommand[] {
  return cloneCommands(loaderDir);
}

export function commandsForPhase(
  phase: PhaseId,
  input: { mode: EnvironmentMode; loaderDir: string; cleanup?: boolean },
): RunnerCommand[] {
  if (input.cleanup) {
    return phase === "configure-isc"
      ? [...cloneCommands(input.loaderDir), loaderCommand(input.loaderDir, "pre-import")]
      : [];
  }
  switch (phase) {
    case "validate":
      return [];
    case "deploy":
      return input.mode === "create"
        ? [{ command: "python", args: ["examples/finbot-bedrock/deploy_agent.py"] }]
        : [];
    case "configure-isc":
      return [loaderCommand(input.loaderDir, "import"), loaderCommand(input.loaderDir, "pre-aggregate")];
    case "aggregate":
      return [loaderCommand(input.loaderDir, "aggregate")];
    case "verify":
      return [loaderCommand(input.loaderDir, "post-aggregate")];
  }
}

export function sensitiveText(secretBody: string): string[] {
  const parsed = JSON.parse(secretBody) as unknown;
  const values: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      values.push(value);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  walk(parsed);
  return values.filter((value) => value.length >= 8);
}

export function secretFiles(
  secretBody: string,
  loaderDir: string,
): Array<{ path: string; contents: string }> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(secretBody) as Record<string, unknown>;
  } catch {
    throw new Error("Secret reference must be JSON with ISC target fields.");
  }
  for (const field of SECRET_FIELDS) {
    if (typeof parsed[field] !== "string" || !String(parsed[field]).trim()) {
      throw new Error(`Secret reference is missing ${field}.`);
    }
  }
  if (!parsed.sourceCredentials || typeof parsed.sourceCredentials !== "object") {
    throw new Error("Secret reference is missing sourceCredentials.");
  }
  const env = SECRET_FIELDS.map((field) => `${field}=${String(parsed[field])}`).join("\n");
  return [
    { path: `${loaderDir}/.env.agentforge`, contents: `${env}\n` },
    {
      path: `${loaderDir}/config-templates/${SAF_CONFIG_TEMPLATE}/source-credentials.json`,
      contents: `${JSON.stringify(parsed.sourceCredentials, null, 2)}\n`,
    },
  ];
}

export async function executePreparation(
  environment: EnvironmentRecord,
  run: EnvironmentRun,
  deps: RunnerDependencies,
  loaderDir: string,
  now = () => new Date().toISOString(),
  onUpdate?: (run: EnvironmentRun) => Promise<void>,
): Promise<EnvironmentRun> {
  let current = run;
  const pending = new Set(incompletePhases(current).map((phase) => phase.id));
  const persist = async (next: EnvironmentRun) => {
    current = next;
    await onUpdate?.(current);
  };

  try {
    await deps.assumeRole(environment.roleArn);
    if (pending.has("validate")) {
      current = applyPhaseResult(
        current,
        "validate",
        "succeeded",
        phaseDetail(environment, "validate", current.agents),
        {},
        now(),
      );
      await persist(current);
    }
  } catch (error) {
    const phase = pending.has("validate")
      ? "validate"
      : (incompletePhases(current)[0]?.id ?? "validate");
    current = applyPhaseResult(current, phase, "failed", safeDetail(error), {}, now());
    await persist(current);
    return current;
  }

  if (pending.has("deploy")) {
    current = await runStep(environment, current, "deploy", [], async () => {
      for (const command of commandsForPhase("deploy", { mode: environment.mode, loaderDir })) {
        await deps.run(command);
      }
      return {};
    }, now);
    await persist(current);
    if (failed(current, "deploy")) return current;
  }

  const loaderPhases = ["configure-isc", "aggregate", "verify"] as const;
  const needsLoader = loaderPhases.some((phase) => pending.has(phase));
  let files: Array<{ path: string; contents: string }> = [];
  let sensitive: string[] = [];
  try {
    if (needsLoader) {
      try {
        const secret = await deps.readSecret(environment.secretRef);
        sensitive = sensitiveText(secret);
        files = secretFiles(secret, loaderDir);
        await deps.writeFiles(files);
        for (const command of loaderSetupCommands(loaderDir)) {
          await deps.run(command);
        }
      } catch (error) {
        const phase = loaderPhases.find((item) => pending.has(item)) ?? "configure-isc";
        await persist(applyPhaseResult(current, phase, "failed", safeDetail(error, sensitive), {}, now()));
        return current;
      }
    }

    for (const phase of loaderPhases) {
      if (!pending.has(phase)) continue;
      current = await runStep(environment, current, phase, sensitive, async () => {
        for (const command of commandsForPhase(phase, { mode: environment.mode, loaderDir })) {
          await deps.run(command);
        }
        if (phase !== "verify") return {};
        const discovered = await deps.listAgents(environment.region, environment.accountId);
        const agents = discovered.length > 0 ? discovered : awsEnvironmentAdapter.discoverAgents(environment, current);
        if (agents.length === 0) {
          throw new Error("No AgentCore agents were discovered.");
        }
        return { agents };
      }, now);
      await persist(current);
      if (failed(current, phase)) return current;
    }
    return current;
  } finally {
    if (files.length > 0) {
      await deps.removeFiles(files.map((file) => file.path));
    }
  }
}

export async function executeCleanup(
  environment: EnvironmentRecord,
  deps: RunnerDependencies,
  loaderDir: string,
): Promise<void> {
  const files = secretFiles(await deps.readSecret(environment.secretRef), loaderDir);
  await deps.writeFiles(files);
  try {
    for (const command of commandsForPhase("configure-isc", {
      mode: environment.mode,
      loaderDir,
      cleanup: true,
    })) {
      await deps.run(command);
    }
  } finally {
    await deps.removeFiles(files.map((file) => file.path));
  }
}

function cloneCommands(loaderDir: string): RunnerCommand[] {
  return [
    { command: "git", args: ["clone", SAF_LOADER_REPOSITORY, loaderDir] },
    { command: "git", args: ["-C", loaderDir, "fetch", "--depth", "1", "origin", SAF_LOADER_REVISION] },
    { command: "git", args: ["-C", loaderDir, "checkout", SAF_LOADER_REVISION] },
    { command: "uv", args: ["sync"], cwd: loaderDir },
  ];
}

function loaderCommand(loaderDir: string, phase: string): RunnerCommand {
  return {
    command: "uv",
    args: ["run", "saf-tenant", phase, "--config-template", SAF_CONFIG_TEMPLATE, "--env-file", ".env.agentforge"],
    cwd: loaderDir,
  };
}

async function runStep(
  environment: EnvironmentRecord,
  run: EnvironmentRun,
  phase: PhaseId,
  sensitive: string[],
  action: () => Promise<{ agents?: DiscoveredAgent[] }>,
  now: () => string,
): Promise<EnvironmentRun> {
  if (phase === "deploy" && environment.mode === "existing") {
    return applyPhaseResult(run, phase, "skipped", "Existing environment.", {}, now());
  }
  try {
    const result = await action();
    const agents = result.agents ?? run.agents;
    return applyPhaseResult(
      run,
      phase,
      "succeeded",
      phaseDetail(environment, phase, agents),
      { agents },
      now(),
    );
  } catch (error) {
    return applyPhaseResult(run, phase, "failed", safeDetail(error, sensitive), {}, now());
  }
}

function failed(run: EnvironmentRun, phase: PhaseId): boolean {
  return run.phases.find((item) => item.id === phase)?.status === "failed";
}

function safeDetail(error: unknown, sensitive: string[] = []): string {
  const message = error instanceof Error ? error.message : "Phase failed.";
  const scrubbed = sensitive.reduce(
    (current, value) => (value.length >= 8 ? current.split(value).join("[redacted]") : current),
    message,
  );
  const redacted = redactSecrets(scrubbed);
  return typeof redacted === "string" && redacted.trim() ? redacted : "Phase failed.";
}
