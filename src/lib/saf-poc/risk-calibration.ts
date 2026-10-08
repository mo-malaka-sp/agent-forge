import { loadSafPocConfig } from "@/lib/saf-poc/config";
import type { SailPointSetupConfig } from "@/lib/saf-poc/sailpoint";
import { getSafPocStore } from "@/lib/saf-poc/storage";
import {
  aggregateAgentRiskInputs,
  patchAgentRiskInputs,
  readAgentRiskInputs,
  type AgentRiskInputs,
} from "@/lib/saf-poc/tenant-agents";

const CALIBRATION_PREFIX = "RISK_CALIBRATION#";

export type RiskFactors = Pick<
  AgentRiskInputs,
  "owners" | "userEntitlements" | "businessApplicationRefs"
>;

export type CalibratedProfile = {
  candidate: string;
  factors: RiskFactors;
  score: number | null;
  severity: string;
  observedAt: string;
};

export type RiskCalibration = {
  agentId: string;
  baseline: RiskFactors;
  baselineScore: number | null;
  baselineSeverity: string;
  sourceId: string;
  datasetId: string;
  profiles: Record<string, CalibratedProfile>;
  attemptedCandidates: string[];
  updatedAt: string;
};

export type CalibrationCandidate = "least-access" | "unowned" | "unowned-least-access";

function calibrationKey(agentId: string): string {
  return `${CALIBRATION_PREFIX}${agentId}`;
}

function factorsFrom(inputs: AgentRiskInputs): RiskFactors {
  return {
    owners: inputs.owners,
    userEntitlements: inputs.userEntitlements,
    businessApplicationRefs: inputs.businessApplicationRefs,
  };
}

function emptyOwners(): Record<string, unknown> {
  return { primaryIdentity: null, secondaryIdentities: [] };
}

function factorsForCandidate(
  candidate: CalibrationCandidate,
  baseline: RiskFactors,
): RiskFactors {
  if (candidate === "least-access") {
    return { ...baseline, userEntitlements: [] };
  }
  if (candidate === "unowned") {
    return { ...baseline, owners: emptyOwners() };
  }
  return {
    owners: emptyOwners(),
    userEntitlements: [],
    businessApplicationRefs: [],
  };
}

async function waitForRiskCalculation(
  agentId: string,
  before: AgentRiskInputs,
  config: SailPointSetupConfig,
): Promise<{ inputs: AgentRiskInputs; changed: boolean }> {
  let latest = before;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    latest = await readAgentRiskInputs(agentId, config);
    if (latest.score !== before.score || latest.severity !== before.severity) {
      return { inputs: latest, changed: true };
    }
  }
  return { inputs: latest, changed: false };
}

function assertPolicyConcierge(inputs: AgentRiskInputs): void {
  if (inputs.name.toUpperCase() !== "POLICY_CONCIERGE") {
    throw new Error("Risk calibration is restricted to POLICY_CONCIERGE.");
  }
}

export async function readRiskCalibration(
  agentId: string,
): Promise<RiskCalibration | null> {
  return getSafPocStore().get<RiskCalibration>(calibrationKey(agentId));
}

export async function captureRiskBaseline(
  agentId: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
): Promise<RiskCalibration> {
  const existing = await readRiskCalibration(agentId);
  if (existing) {
    return existing;
  }
  const inputs = await readAgentRiskInputs(agentId, config);
  assertPolicyConcierge(inputs);
  const baseline = factorsFrom(inputs);
  const profiles = {
    [inputs.severity.toLowerCase()]: {
      candidate: "baseline",
      factors: baseline,
      score: inputs.score,
      severity: inputs.severity,
      observedAt: new Date().toISOString(),
    },
  };
  const calibration: RiskCalibration = {
    agentId,
    baseline,
    baselineScore: inputs.score,
    baselineSeverity: inputs.severity,
    sourceId: inputs.sourceId,
    datasetId: inputs.datasetId,
    profiles,
    attemptedCandidates: [],
    updatedAt: new Date().toISOString(),
  };
  await getSafPocStore().put(calibrationKey(agentId), calibration);
  return calibration;
}

export async function probeRiskCandidate(
  agentId: string,
  candidate: CalibrationCandidate,
  config: SailPointSetupConfig = loadSafPocConfig(),
): Promise<{ calibration: RiskCalibration; observed: AgentRiskInputs }> {
  const calibration =
    (await readRiskCalibration(agentId)) ?? (await captureRiskBaseline(agentId, config));
  assertPolicyConcierge(await readAgentRiskInputs(agentId, config));
  const factors = factorsForCandidate(candidate, calibration.baseline);
  let observed: AgentRiskInputs;
  try {
    await patchAgentRiskInputs(agentId, factors, config);
    const afterPatch = await readAgentRiskInputs(agentId, config);
    await aggregateAgentRiskInputs(calibration.sourceId, calibration.datasetId, config);
    const result = await waitForRiskCalculation(agentId, afterPatch, config);
    observed = result.inputs;
    if (!result.changed) {
      const next = {
        ...calibration,
        attemptedCandidates: Array.from(
          new Set([...calibration.attemptedCandidates, candidate]),
        ),
        updatedAt: new Date().toISOString(),
      };
      await getSafPocStore().put(calibrationKey(agentId), next);
      return { calibration: next, observed };
    }
  } catch (error) {
    await patchAgentRiskInputs(agentId, calibration.baseline, config).catch(() => undefined);
    throw error;
  }
  const severityKey = observed.severity.toLowerCase();
  const next: RiskCalibration = {
    ...calibration,
    profiles: {
      ...calibration.profiles,
      ...(severityKey === "unavailable"
        ? {}
        : {
            [severityKey]: {
              candidate,
              factors,
              score: observed.score,
              severity: observed.severity,
              observedAt: new Date().toISOString(),
            },
          }),
    },
    attemptedCandidates: Array.from(
      new Set([...calibration.attemptedCandidates, candidate]),
    ),
    updatedAt: new Date().toISOString(),
  };
  await getSafPocStore().put(calibrationKey(agentId), next);
  return { calibration: next, observed };
}

export async function restoreRiskBaseline(
  agentId: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
): Promise<{ calibration: RiskCalibration; observed: AgentRiskInputs }> {
  const calibration = await readRiskCalibration(agentId);
  if (!calibration) {
    throw new Error("Capture a calibration baseline before restoring it.");
  }
  assertPolicyConcierge(await readAgentRiskInputs(agentId, config));
  await patchAgentRiskInputs(agentId, calibration.baseline, config);
  const afterPatch = await readAgentRiskInputs(agentId, config);
  await aggregateAgentRiskInputs(calibration.sourceId, calibration.datasetId, config);
  const observed = (await waitForRiskCalculation(agentId, afterPatch, config)).inputs;
  return { calibration, observed };
}

export async function applyCalibratedRiskProfile(
  agentId: string,
  requestedLevel: string,
  config: SailPointSetupConfig = loadSafPocConfig(),
): Promise<{ calibration: RiskCalibration; observed: AgentRiskInputs }> {
  const calibration = await readRiskCalibration(agentId);
  const profile = calibration?.profiles[requestedLevel.trim().toLowerCase()];
  if (!calibration || !profile) {
    throw new Error(
      `${requestedLevel} has not been observed for this agent. Run calibration first.`,
    );
  }
  const before = await readAgentRiskInputs(agentId, config);
  assertPolicyConcierge(before);
  await patchAgentRiskInputs(agentId, profile.factors, config);
  const afterPatch = await readAgentRiskInputs(agentId, config);
  await aggregateAgentRiskInputs(calibration.sourceId, calibration.datasetId, config);
  const observed = (await waitForRiskCalculation(agentId, afterPatch, config)).inputs;
  if (observed.severity.toLowerCase() !== requestedLevel.trim().toLowerCase()) {
    throw new Error(
      `SailPoint calculated ${observed.severity} (score ${observed.score ?? "unavailable"}) after the ${profile.candidate} profile; requested ${requestedLevel}. Previous severity was ${before.severity}.`,
    );
  }
  return { calibration, observed };
}
