import { evaluateAuthorization } from "@/lib/agents/authorization";
import {
  getAgentById,
  createAgentsBulk,
  removeAgentEntitlement,
} from "@/lib/agents/repository";
import { serializeAgent } from "@/lib/agents/serializer";
import { DEMO_STEPS, type DemoStepId } from "@/lib/demo/steps";
import type { AgentRow } from "@/lib/db/schema";
import { HERO_AGENT_ID_BY_PROVIDER } from "@/lib/db/hero-seed-data";
import { countAgents } from "@/lib/db/store";
import {
  getIscConfigForProvider,
  type IscConfig,
} from "@/lib/isc/config";
import { getDatasetId } from "@/lib/isc/settings-store";
import { AGENT_RESOURCE_TYPE, ensureAgentDataset } from "@/lib/isc/datasets";
import {
  describeMissingResourceOperations,
  findMissingResourceOperations,
  readSourceOperations,
} from "@/lib/isc/source-operations";
import { resolveDeploymentProvider as resolveProviderFromRow } from "@/lib/providers/deployment";
import {
  DEPLOYMENT_PROVIDERS,
  type DeploymentProvider,
} from "@/lib/providers/profiles";
import {
  startAccountAggregation,
  startDatasetAggregation,
  updateMachineAccountMappings,
  verifySourceData,
  revokeEntitlementAccess,
} from "@/lib/isc";
import type { DemoStepPayload } from "@/lib/validation/demo.schema";

export interface DemoStepResult {
  step: DemoStepId;
  status: "completed" | "started" | "manual";
  message: string;
  system: "agentforge" | "isc";
  taskId: string | null;
  result: unknown;
}

function resolveDemoDeploymentProvider(
  payload: DemoStepPayload,
  agentRow?: AgentRow | null,
): DeploymentProvider {
  if (payload.deployment_provider) {
    return payload.deployment_provider;
  }
  if (agentRow) {
    return resolveProviderFromRow(agentRow.deploymentProvider);
  }
  return "aws_bedrock";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireIscConfig(provider: DeploymentProvider): IscConfig {
  const config = getIscConfigForProvider(provider);
  if (!config) {
    throw new Error(
      `ISC source not configured for ${DEPLOYMENT_PROVIDERS[provider].label}. Save the source ID under ISC sources on the Demo page.`,
    );
  }
  return config;
}

function defaultAgentId(payload: DemoStepPayload): string {
  return payload.agent_id ?? process.env.ISC_DEMO_AGENT_ID?.trim() ?? "agt_demo_aws_bedrock";
}

function defaultPrincipal(payload: DemoStepPayload): string {
  return payload.principal ?? "demo-user";
}

function defaultAllowPermission(payload: DemoStepPayload): string {
  return payload.permission ?? "S3:Read";
}

function preferredMachineIdentityDatasetIds(
  payload: DemoStepPayload,
  provider: DeploymentProvider,
): string[] {
  if (payload.dataset_ids?.length) {
    return payload.dataset_ids;
  }
  if (payload.schemas?.length) {
    return payload.schemas;
  }
  return [getDatasetId(provider)];
}

function defaultRevokeEntitlement(payload: DemoStepPayload): string {
  return payload.entitlement ?? "Jira:Admin";
}

export async function runDemoStep(
  payload: DemoStepPayload,
  baseUrl: string,
): Promise<DemoStepResult> {
  const definition = DEMO_STEPS[payload.step];
  const system = definition.system;
  const agentForProvider =
    payload.agent_id != null ? await getAgentById(payload.agent_id) : null;
  const deploymentProvider = resolveDemoDeploymentProvider(
    payload,
    agentForProvider,
  );

  switch (payload.step) {
    case "bulk-create": {
      const deploymentProvider =
        payload.deployment_provider ?? "aws_bedrock";
      const additionalCount = payload.count ?? 0;

      const created =
        additionalCount > 0
          ? await createAgentsBulk({
              deployment_provider: deploymentProvider,
              count: additionalCount,
            })
          : [];

      const totalForPlatform = countAgents({
        status: "active",
        deploymentProvider,
      });
      const heroId = HERO_AGENT_ID_BY_PROVIDER[deploymentProvider];

      const message =
        additionalCount === 0
          ? `Using seeded hero only on ${deploymentProvider.replace("_", " ")} (${heroId}). ${totalForPlatform} active agent(s) on this platform — open Agents to verify.`
          : `Added ${created.length} additional agent(s) on ${deploymentProvider.replace("_", " ")}. Total on this platform: ${totalForPlatform} (1 hero + ${created.length} additional). ISC sync happens in steps 4–5.`;

      return {
        step: payload.step,
        status: "completed",
        message,
        system,
        taskId: null,
        result: {
          additional_count: created.length,
          heroes_on_platform: 1,
          total_on_platform: totalForPlatform,
          hero_agent_id: heroId,
          agents: created.map((row) => serializeAgent(row, baseUrl)),
        },
      };
    }

    case "entitlement-aggregation":
    case "entitlement-aggregation-outbound": {
      return {
        step: payload.step,
        status: "manual",
        message:
          "Confirmed — outboundPermissions aggregation completed in ISC UI",
        system,
        taskId: null,
        result: {
          manual: true,
          entitlementType: "outboundPermissions",
          uiPath:
            "Source → Entitlement Aggregation → Specific Types → outboundPermissions",
        },
      };
    }

    case "entitlement-aggregation-inbound": {
      return {
        step: payload.step,
        status: "manual",
        message:
          "Confirmed — inboundCallers aggregation completed in ISC UI",
        system,
        taskId: null,
        result: {
          manual: true,
          entitlementType: "inboundCallers",
          uiPath:
            "Source → Entitlement Aggregation → Specific Types → inboundCallers",
        },
      };
    }

    case "machine-identity-aggregation": {
      const config = requireIscConfig(deploymentProvider);
      const preferredIds = preferredMachineIdentityDatasetIds(
        payload,
        deploymentProvider,
      );
      const ensured = await Promise.all(
        preferredIds.map((datasetId) =>
          ensureAgentDataset(config, {
            datasetId,
            displayName: datasetId,
          }).catch((error: unknown) => {
            throw new Error(
              `Could not create or read dataset “${datasetId}” / its ${AGENT_RESOURCE_TYPE} resource on source ${config.sourceId} — ${errorMessage(error)}`,
            );
          }),
        ),
      );
      const datasetIds = ensured.map((result) => result.dataset.id);

      // Fail here rather than waiting on an ISC task that cannot match an
      // endpoint, and name the source so a misfiled source ID is obvious.
      const operations = await readSourceOperations(config).catch(() => null);
      if (operations) {
        const missing = findMissingResourceOperations(operations, preferredIds);
        if (missing.length > 0) {
          throw new Error(
            `Dataset aggregation cannot run: ${describeMissingResourceOperations(operations, missing)}`,
          );
        }
      }

      const started = await Promise.all(
        datasetIds.map((datasetId) =>
          startDatasetAggregation(config, datasetId).catch((error: unknown) => {
            throw new Error(
              `Dataset “${datasetId}” exists but aggregation did not start — ${errorMessage(error)}`,
            );
          }),
        ),
      );

      return {
        step: payload.step,
        status: "started",
        message: `Dataset aggregation started (${datasetIds.join(", ")})`,
        system,
        taskId: started[0]?.taskId ?? null,
        result: {
          aggregations: started.map((result, index) => ({
            datasetId: datasetIds[index],
            taskId: result.taskId,
            raw: result.raw,
          })),
          datasetIds,
          ensured,
        },
      };
    }

    case "account-aggregation": {
      const config = requireIscConfig(deploymentProvider);
      const started = await startAccountAggregation(config);

      return {
        step: payload.step,
        status: "started",
        message: "Account aggregation started",
        system,
        taskId: started.taskId,
        result: started.raw,
      };
    }

    case "machine-account-mappings": {
      const config = requireIscConfig(deploymentProvider);
      const result = await updateMachineAccountMappings(config);
      const submitted = result.classification.accountsSubmitted ?? 0;
      const mode = result.classification.mode;

      return {
        step: payload.step,
        status:
          submitted > 0 || mode === "already-linked" ? "completed" : "manual",
        message:
          mode === "already-linked"
            ? `Machine accounts already linked (${submitted} on source); mappings confirmed`
            : submitted > 0
              ? `Machine account mappings updated; ${submitted} account(s) classified via ${mode}`
              : "Mappings saved but 0 accounts classified. Configure machine account classification on the source in ISC, then re-run Step 6.",
        system,
        taskId: null,
        result,
      };
    }

    case "verify": {
      const config = requireIscConfig(deploymentProvider);
      const verification = await verifySourceData(config);
      const summary = `Found ${verification.accountCount} accounts, ${verification.machineAccountCount} machine accounts, ${verification.entitlementCount} entitlements`;
      const message = verification.accessReady
        ? `${summary}. Link accounts on AI Agent → Accounts if Access is still empty.`
        : `${summary}. ${verification.hints.join(" ")}`;

      return {
        step: payload.step,
        status: verification.accessReady ? "completed" : "manual",
        message,
        system,
        taskId: null,
        result: verification,
      };
    }

    case "authorize-allow": {
      const agentId = defaultAgentId(payload);
      const agent = await getAgentById(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const authorization = evaluateAuthorization(agent, {
        principal: defaultPrincipal(payload),
        direction: "outbound",
        permission: defaultAllowPermission(payload),
      });

      return {
        step: payload.step,
        status: "completed",
        message: `Authorization decision: ${authorization.decision}`,
        system,
        taskId: null,
        result: authorization,
      };
    }

    case "revoke-entitlement": {
      const revokeVia = payload.revoke_via ?? "agentforge";
      const entitlement = defaultRevokeEntitlement(payload);

      if (revokeVia === "isc") {
        const config = requireIscConfig(deploymentProvider);
        if (
          !payload.identity_id ||
          !payload.entitlement_id ||
          !payload.native_identity
        ) {
          throw new Error(
            "ISC revoke requires identity_id, entitlement_id, and native_identity",
          );
        }

        const response = await revokeEntitlementAccess(config, {
          identityId: payload.identity_id,
          entitlementId: payload.entitlement_id,
          nativeIdentity: payload.native_identity,
          assignmentId: payload.assignment_id,
        });

        return {
          step: payload.step,
          status: "started",
          message: "ISC access revoke request submitted",
          system: "isc",
          taskId: null,
          result: response,
        };
      }

      const agentId = defaultAgentId(payload);
      const updated = await removeAgentEntitlement({
        ref: { accountId: agentId },
        deploymentProvider: payload.deployment_provider ?? "aws_bedrock",
        attribute: "outboundPermissions",
        entitlement,
        baseUrl,
      });

      return {
        step: payload.step,
        status: "completed",
        message: `Removed entitlement ${entitlement} from agent ${updated.name}`,
        system,
        taskId: null,
        result: serializeAgent(updated, baseUrl),
      };
    }

    case "account-aggregation-refresh": {
      const config = requireIscConfig(deploymentProvider);
      const started = await startAccountAggregation(config, {
        disableOptimization: true,
      });

      return {
        step: payload.step,
        status: "started",
        message: "Unoptimized account aggregation started",
        system,
        taskId: started.taskId,
        result: started.raw,
      };
    }

    case "authorize-deny": {
      const agentId = defaultAgentId(payload);
      const agent = await getAgentById(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const permission = defaultRevokeEntitlement(payload);
      const authorization = evaluateAuthorization(agent, {
        principal: defaultPrincipal(payload),
        direction: "outbound",
        permission,
      });

      return {
        step: payload.step,
        status: "completed",
        message: `Authorization decision: ${authorization.decision}`,
        system,
        taskId: null,
        result: authorization,
      };
    }

    default: {
      const unreachable: never = payload.step;
      throw new Error(`Unsupported demo step: ${unreachable}`);
    }
  }
}
