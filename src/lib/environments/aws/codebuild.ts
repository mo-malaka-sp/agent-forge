import { createHash } from "node:crypto";

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

import type { EnvironmentRecord, EnvironmentRun } from "@/lib/environments/types";

export interface BuildStart {
  id: string;
}

export interface BuildStarter {
  startBuild(input: {
    projectName: string;
    environmentVariables: Array<{ name: string; value: string }>;
  }): Promise<BuildStart>;
}

export function codeBuildProjectName(): string | undefined {
  return process.env.ENVIRONMENT_CODEBUILD_PROJECT?.trim() || undefined;
}

export function environmentBuildVariables(
  environment: EnvironmentRecord,
  run: EnvironmentRun,
  extra: Array<{ name: string; value: string }> = [],
): Array<{ name: string; value: string }> {
  return [
    { name: "ENVIRONMENT_ID", value: environment.id },
    { name: "ENVIRONMENT_RUN_ID", value: run.id },
    { name: "ENVIRONMENT_MODE", value: environment.mode },
    { name: "ENVIRONMENT_ROLE_ARN", value: environment.roleArn },
    { name: "ENVIRONMENT_SECRET_REF", value: environment.secretRef },
    { name: "ENVIRONMENT_REGION", value: environment.region },
    { name: "ENVIRONMENT_ISC_SOURCE_NAME", value: environment.iscSourceName },
    { name: "ENVIRONMENT_TABLE_NAME", value: process.env.ENVIRONMENT_TABLE_NAME?.trim() || "" },
    ...extra,
  ];
}

export function startBuildBody(
  projectName: string,
  environmentVariables: Array<{ name: string; value: string }>,
): string {
  return JSON.stringify({
    projectName,
    environmentVariablesOverride: environmentVariables.map((item) => ({
      name: item.name,
      value: item.value,
      type: "PLAINTEXT",
    })),
  });
}

class Sha256 {
  private readonly hash = createHash("sha256");

  update(data: Uint8Array): void {
    this.hash.update(data);
  }

  async digest(): Promise<Uint8Array> {
    return this.hash.digest();
  }
}

export function createAwsBuildStarter(): BuildStarter {
  return {
    async startBuild(input) {
      const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
      const hostname = `codebuild.${region}.amazonaws.com`;
      const body = startBuildBody(input.projectName, input.environmentVariables);
      const signer = new SignatureV4({
        credentials: defaultProvider(),
        region,
        service: "codebuild",
        sha256: Sha256,
      });
      const signed = await signer.sign({
        method: "POST",
        protocol: "https:",
        hostname,
        path: "/",
        headers: {
          host: hostname,
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "CodeBuild_20161006.StartBuild",
        },
        body,
      });
      const response = await fetch(`https://${hostname}/`, {
        method: "POST",
        headers: signed.headers,
        body,
      });
      const payload = (await response.json()) as { build?: { id?: string }; message?: string };
      if (!response.ok || !payload.build?.id) {
        throw new Error(payload.message || "CodeBuild did not return a build ID.");
      }
      return { id: payload.build.id };
    },
  };
}
