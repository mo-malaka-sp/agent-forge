import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { executeCleanup, executePreparation, type RunnerCommand } from "@/lib/environments/aws/runner";
import { getEnvironmentStore } from "@/lib/environments/store";

const exec = promisify(execFile);
const store = getEnvironmentStore();

async function main(): Promise<void> {
  const environmentId = required("ENVIRONMENT_ID");
  const environment = await store.getEnvironment(environmentId);
  if (!environment) {
    throw new Error("Environment preparation record was not found.");
  }
  const loaderDir = path.join(process.cwd(), ".environment-runner", environmentId);
  if (process.env.ENVIRONMENT_CLEANUP_CONFIRMED === "delete-sources") {
    await executeCleanup(environment, dependencies(), loaderDir);
    return;
  }

  const runId = required("ENVIRONMENT_RUN_ID");
  const run = await store.getRun(environmentId, runId);
  if (!run) {
    throw new Error("Environment preparation record was not found.");
  }
  await executePreparation(environment, run, dependencies(), loaderDir, undefined, (next) =>
    store.saveRun(next),
  );
}

function dependencies() {
  let session: NodeJS.ProcessEnv = process.env;
  return {
    async assumeRole(roleArn: string) {
      const { stdout } = await exec(
        "aws",
        [
          "sts",
          "assume-role",
          "--role-arn",
          roleArn,
          "--role-session-name",
          "agentforge-environment",
          "--output",
          "json",
        ],
        { env: process.env },
      );
      const parsed = JSON.parse(stdout) as {
        Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string };
      };
      const credentials = parsed.Credentials;
      if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
        throw new Error("Role assumption did not return a session.");
      }
      session = {
        ...process.env,
        AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
        AWS_SESSION_TOKEN: credentials.SessionToken,
      };
    },
    async readSecret(secretRef: string) {
      const { stdout } = await exec(
        "aws",
        ["secretsmanager", "get-secret-value", "--secret-id", secretRef, "--query", "SecretString", "--output", "text"],
        { env: process.env },
      );
      return stdout.trim();
    },
    async run(command: RunnerCommand) {
      await exec(command.command, command.args, {
        cwd: command.cwd,
        env: session,
      });
    },
    async listAgents(region: string) {
      const { stdout } = await exec(
        "aws",
        ["bedrock-agentcore-control", "list-agent-runtimes", "--region", region, "--output", "json"],
        { env: session },
      );
      const parsed = JSON.parse(stdout) as {
        agentRuntimes?: Array<{ agentRuntimeName?: string; agentRuntimeArn?: string }>;
      };
      return (parsed.agentRuntimes ?? [])
        .filter((agent) => agent.agentRuntimeArn && agent.agentRuntimeName)
        .map((agent) => ({ name: agent.agentRuntimeName as string, runtimeArn: agent.agentRuntimeArn as string }));
    },
    async writeFiles(files: Array<{ path: string; contents: string }>) {
      for (const file of files) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents, { mode: 0o600 });
      }
    },
    async removeFiles(paths: string[]) {
      await Promise.all(paths.map((filePath) => rm(filePath, { force: true })));
    },
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

void main();
