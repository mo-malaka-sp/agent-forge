import { containsSecretMaterial } from "@/lib/environments/redact";
import type {
  CreateEnvironmentInput,
  DiscoveredAgent,
  EnvironmentRecord,
  EnvironmentRun,
} from "@/lib/environments/types";

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]+$/;
const SECRET_REF =
  /^(arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+|[A-Za-z0-9/_+=.@-]{1,256})$/;
const REGION = /^[a-z]{2}-[a-z]+-\d$/;

export interface AwsConnection {
  accountId: string;
  region: string;
  roleArn: string;
  secretRef: string;
}

export interface EnvironmentAdapter {
  validateConnection(input: CreateEnvironmentInput): AwsConnection;
  discoverAgents(environment: EnvironmentRecord, run: EnvironmentRun): DiscoveredAgent[];
  prepareEnvironment(environment: EnvironmentRecord): string[];
  syncToIsc(environment: EnvironmentRecord): string[];
  verifyInIsc(agents: DiscoveredAgent[]): { ready: boolean; detail: string };
}

export const awsEnvironmentAdapter: EnvironmentAdapter = {
  validateConnection(input) {
    if (input.provider !== "aws") {
      throw new Error("Only AWS environments can be prepared in this version.");
    }
    if (!input.reviewConfirmed) {
      throw new Error("Confirm the review before preparing an environment.");
    }
    if (!input.name.trim() || input.name.trim().length > 80) {
      throw new Error("Enter an environment name.");
    }
    if (!REGION.test(input.region.trim())) {
      throw new Error("Enter an AWS region such as us-east-1.");
    }
    const role = ROLE_ARN.exec(input.roleArn.trim());
    if (!role) {
      throw new Error("Enter a cross-account IAM role ARN.");
    }
    const secretRef = input.secretRef.trim();
    if (!SECRET_REF.test(secretRef) || containsSecretMaterial(secretRef)) {
      throw new Error("Enter a Secrets Manager name or ARN. Do not paste a secret value.");
    }
    return {
      accountId: role[1],
      region: input.region.trim(),
      roleArn: input.roleArn.trim(),
      secretRef,
    };
  },
  discoverAgents(environment, run) {
    if (run.agents.length > 0) {
      return run.agents;
    }
    if (environment.mode !== "create") {
      return [];
    }
    return [
      {
        name: "FinBot-Bedrock",
        runtimeArn: `arn:aws:bedrock-agentcore:${environment.region}:${environment.accountId}:runtime/FinBot_Bedrock`,
      },
    ];
  },
  prepareEnvironment(environment) {
    return environment.mode === "create"
      ? ["python deploy_agent.py"]
      : [];
  },
  syncToIsc() {
    return ["aws:iam", "aws:bedrockagentcore"];
  },
  verifyInIsc(agents) {
    if (agents.length === 0) {
      return { ready: false, detail: "No AgentCore agents were discovered." };
    }
    const linked = agents.filter((agent) => agent.iscAgentId).length;
    return {
      ready: true,
      detail:
        linked === agents.length
          ? `${linked} agent${linked === 1 ? "" : "s"} linked in ISC.`
          : `Discovered ${agents.length} AgentCore agent${agents.length === 1 ? "" : "s"}. ${linked} linked in ISC.`,
    };
  },
};
