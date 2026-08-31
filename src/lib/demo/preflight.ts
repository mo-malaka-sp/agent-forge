import { evaluateAuthorization } from "@/lib/agents/authorization";
import {
  collectAccessEntitlements,
  getInboundAccess,
  getOutboundAccess,
} from "@/lib/agents/access";
import type { DemoModeId } from "@/lib/demo/steps";
import { getGovernDemoProfile } from "@/lib/demo/govern-profiles";
import { DEMO_RESET_AGENT_ID } from "@/lib/db/seed";
import { countAgents, findAgents } from "@/lib/db/store";
import {
  findDemoAgent,
  getDemoGovernExpectedInbound,
  getDemoGovernRequiredEntitlements,
} from "@/lib/demo/reset";
import {
  getIscConfigForProvider,
  getIscCredentials,
  getIscPublicStatus,
} from "@/lib/isc/config";
import { getIscSourceId, getDatasetId } from "@/lib/isc/settings-store";
import { DEPLOYMENT_PROVIDERS, type DeploymentProvider } from "@/lib/providers/profiles";
import { verifySourceData } from "@/lib/isc/verify";
import { listSourceDatasets, matchDataset } from "@/lib/isc/datasets";

export type PreflightStatus = "pass" | "warn" | "fail";

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  message: string;
  detail?: unknown;
}

export interface PreflightResult {
  ready: boolean;
  mode: DemoModeId;
  checked_at: string;
  checks: PreflightCheck[];
}

function hasFailures(checks: PreflightCheck[]): boolean {
  return checks.some((check) => check.status === "fail");
}

export async function runDemoPreflight(
  mode: DemoModeId,
  options?: {
    agentId?: string;
    allowPermission?: string;
    revokeEntitlement?: string;
    principal?: string;
    deploymentProvider?: DeploymentProvider;
  },
): Promise<PreflightResult> {
  const agentId = options?.agentId ?? DEMO_RESET_AGENT_ID;
  const profile = getGovernDemoProfile(agentId);
  const allowPermission =
    options?.allowPermission?.trim() || profile.allowPermission;
  const revokeEntitlement =
    options?.revokeEntitlement?.trim() || profile.revokeEntitlement;
  const principal = options?.principal ?? "demo-user";
  const checks: PreflightCheck[] = [];

  checks.push({
    id: "agentforge",
    label: "AgentForge",
    status: "pass",
    message: "Application is running",
  });

  const iscStatus = getIscPublicStatus();
  const credentials = getIscCredentials();
  checks.push({
    id: "isc_config",
    label: "ISC configuration",
    status: credentials ? "pass" : "fail",
    message: credentials
      ? `Connected to tenant ${iscStatus.tenant}${
          iscStatus.credentialSource === "ui" ? " (UI)" : ""
        }`
      : "Save tenant connection under Demo → ISC sources (or set ISC_TENANT, ISC_CLIENT_ID, and ISC_CLIENT_SECRET)",
    detail: iscStatus,
  });

  if (credentials) {
    for (const provider of Object.keys(DEPLOYMENT_PROVIDERS) as DeploymentProvider[]) {
      const sourceId = getIscSourceId(provider);
      checks.push({
        id: `isc_source_${provider}`,
        label: `${DEPLOYMENT_PROVIDERS[provider].label} source`,
        status: sourceId ? "pass" : "warn",
        message: sourceId
          ? `Source ID saved (${sourceId})`
          : "Not configured — save source ID on Demo → ISC sources",
        detail: { provider, sourceId },
      });
    }
  }

  if (credentials && mode === "full-sync") {
    const provider =
      options?.deploymentProvider ?? ("aws_bedrock" as DeploymentProvider);
    const config = getIscConfigForProvider(provider);
    if (config) {
      const preferredDatasetId = getDatasetId(provider);
      try {
        const datasets = await listSourceDatasets(config);
        const match = matchDataset(datasets, preferredDatasetId);
        checks.push({
          id: "isc_dataset",
          label: `ISC dataset (${DEPLOYMENT_PROVIDERS[provider].label})`,
          status: match ? "pass" : "warn",
          message: match
            ? `Dataset ${match.id} is on the source`
            : `Dataset “${preferredDatasetId}” not listed — create it in Dataset Management or run full sync`,
          detail: {
            provider,
            preferredDatasetId,
            datasets: datasets.map((dataset) => ({
              id: dataset.id,
              name: dataset.name,
            })),
          },
        });
      } catch (error) {
        checks.push({
          id: "isc_dataset",
          label: `ISC dataset (${DEPLOYMENT_PROVIDERS[provider].label})`,
          status: "warn",
          message:
            error instanceof Error
              ? `Could not list datasets: ${error.message}`
              : "Could not list datasets",
          detail: { provider, preferredDatasetId },
        });
      }
    }
  }

  const activeAgentCount = countAgents({ status: "active" });
  const platform =
    options?.deploymentProvider ??
    profile.provider ??
    "aws_bedrock";
  const platformAgentCount = countAgents({
    status: "active",
    deploymentProvider: platform,
  });
  checks.push({
    id: "active_agents",
    label: "Active agents in AgentForge",
    status: activeAgentCount > 0 ? "pass" : "warn",
    message:
      activeAgentCount > 0
        ? `${platformAgentCount} on ${DEPLOYMENT_PROVIDERS[platform].label} (${activeAgentCount} total across platforms)`
        : "No active agents — run step 1 first",
    detail: { count: activeAgentCount, platform, platformAgentCount },
  });

  const { rows: bedrockAgents } = findAgents({
    page: 1,
    limit: 200,
    status: "active",
    deploymentProvider: "aws_bedrock",
  });
  const outboundCatalog = collectAccessEntitlements(bedrockAgents, {
    direction: "outbound",
    platform: "AWS Bedrock",
  });
  const inboundCatalog = collectAccessEntitlements(bedrockAgents, {
    direction: "inbound",
    platform: "AWS Bedrock",
  });

  if (mode === "full-sync") {
    checks.push({
      id: "entitlement_catalog",
      label: "Entitlement catalog (AgentForge)",
      status:
        outboundCatalog.length > 0 && inboundCatalog.length > 0 ? "pass" : "warn",
      message:
        outboundCatalog.length > 0 && inboundCatalog.length > 0
          ? `${outboundCatalog.length} outbound and ${inboundCatalog.length} inbound entitlements`
          : "Entitlement catalog is empty — run step 1 or reset demo agent",
      detail: {
        outbound: outboundCatalog.length,
        inbound: inboundCatalog.length,
      },
    });

    if (iscStatus.configured) {
      const provider =
        options?.deploymentProvider ?? ("aws_bedrock" as DeploymentProvider);
      const config = getIscConfigForProvider(provider);
      if (config) {
        try {
          const verify = await verifySourceData(config);
          const synced =
            verify.accountCount > 0 &&
            verify.machineAccountCount > 0 &&
            verify.entitlementCount > 0;
          checks.push({
            id: "isc_sync",
            label: `ISC sync state (${DEPLOYMENT_PROVIDERS[provider].label})`,
            status: synced ? "pass" : "warn",
            message: synced
              ? `ISC has ${verify.accountCount} accounts, ${verify.machineAccountCount} machine accounts, ${verify.entitlementCount} entitlements`
              : `ISC not fully synced for ${DEPLOYMENT_PROVIDERS[provider].label} — complete full sync steps or run verify`,
            detail: { provider, ...verify },
          });
        } catch (error) {
          checks.push({
            id: "isc_sync",
            label: `ISC sync state (${DEPLOYMENT_PROVIDERS[provider].label})`,
            status: "warn",
            message:
              error instanceof Error
                ? `Could not verify ISC sync: ${error.message}`
                : "Could not verify ISC sync",
          });
        }
      }
    }
  }

  if (mode === "govern-enforce") {
    const demoAgent = findDemoAgent(agentId);
    const expectedInbound = getDemoGovernExpectedInbound(agentId);
    const required = getDemoGovernRequiredEntitlements(
      agentId,
      allowPermission,
      revokeEntitlement,
    );
    const [, requiredRevoke] = required;

    if (!demoAgent) {
      checks.push({
        id: "demo_agent",
        label: "Demo agent",
        status: "fail",
        message: `Agent ${agentId} not found — run full sync step 1 or restore demo agent`,
        detail: {
          expected_id: agentId,
          expected_name: profile.label,
        },
      });
    } else {
      checks.push({
        id: "demo_agent",
        label: "Demo agent",
        status: demoAgent.status === "active" ? "pass" : "fail",
        message:
          demoAgent.status === "active"
            ? `${demoAgent.name} (${demoAgent.id}) is active`
            : `${demoAgent.name} is ${demoAgent.status} — enable or reset demo agent`,
        detail: { id: demoAgent.id, name: demoAgent.name, status: demoAgent.status },
      });

      const actualOutbound = getOutboundAccess(demoAgent);
      const missingRequired = required.filter(
        (entitlement) => !actualOutbound.includes(entitlement),
      );
      const entitlementsOk = missingRequired.length === 0;
      const onlyRevokeEntitlementMissing =
        missingRequired.length === 1 &&
        missingRequired[0] === requiredRevoke;

      checks.push({
        id: "demo_entitlements",
        label: "Govern demo entitlements",
        status: entitlementsOk
          ? "pass"
          : onlyRevokeEntitlementMissing
            ? "warn"
            : "fail",
        message: entitlementsOk
          ? `Required entitlements present (${required.join(", ")})`
          : onlyRevokeEntitlementMissing
            ? `${requiredRevoke} already removed — continue to re-aggregate or reset demo agent to run again`
            : `Missing ${missingRequired.join(", ")} — restore demo agent before govern + enforce`,
        detail: {
          required,
          actual: actualOutbound,
          missing: missingRequired,
        },
      });

      const actualInbound = getInboundAccess(demoAgent);
      const inboundOk =
        expectedInbound.length === 0 ||
        expectedInbound.every((caller) => actualInbound.includes(caller));

      checks.push({
        id: "demo_inbound",
        label: "Inbound callers",
        status: inboundOk ? "pass" : "warn",
        message: inboundOk
          ? `${actualInbound.length} inbound caller(s) configured`
          : "Inbound callers differ from demo seed — reset demo agent if needed",
        detail: { expected: expectedInbound, actual: actualInbound },
      });

      if (demoAgent.status === "active" && (entitlementsOk || onlyRevokeEntitlementMissing)) {
        const authorization = evaluateAuthorization(demoAgent, {
          principal,
          direction: "outbound",
          permission: allowPermission,
        });
        checks.push({
          id: "authorize_allow_probe",
          label: `Authorize allow probe (${allowPermission})`,
          status: authorization.decision === "allow" ? "pass" : "fail",
          message:
            authorization.decision === "allow"
              ? `Authorization returns allow for ${allowPermission}`
              : `Authorization denied ${allowPermission} — reset demo agent`,
          detail: {
            decision: authorization.decision,
            reason: authorization.reason,
          },
        });

        const denyProbe = evaluateAuthorization(demoAgent, {
          principal,
          direction: "outbound",
          permission: revokeEntitlement,
        });
        if (!actualOutbound.includes(revokeEntitlement)) {
          checks.push({
            id: "revoke_already_applied",
            label: "Revoke entitlement state",
            status: "warn",
            message: `${revokeEntitlement} already removed — reset demo agent before re-running govern + enforce`,
          });
        } else {
          checks.push({
            id: "revoke_ready",
            label: "Revoke entitlement ready",
            status: "pass",
            message: `${revokeEntitlement} is present and can be revoked in step 2`,
            detail: { probe_decision: denyProbe.decision },
          });
        }
      }
    }
  }

  return {
    ready: !hasFailures(checks),
    mode,
    checked_at: new Date().toISOString(),
    checks,
  };
}
