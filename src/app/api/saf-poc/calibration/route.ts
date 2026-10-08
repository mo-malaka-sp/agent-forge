import { safError, safJson } from "@/lib/saf-poc/http";
import {
  captureRiskBaseline,
  probeRiskCandidate,
  readRiskCalibration,
  restoreRiskBaseline,
  type CalibrationCandidate,
} from "@/lib/saf-poc/risk-calibration";
import { readAgentRiskInputs } from "@/lib/saf-poc/tenant-agents";

export const runtime = "nodejs";
export const maxDuration = 60;

const CANDIDATES = new Set<CalibrationCandidate>([
  "least-access",
  "unowned",
  "unowned-least-access",
]);

export async function GET(request: Request) {
  try {
    const agentId = new URL(request.url).searchParams.get("agentId")?.trim();
    if (!agentId) {
      return safJson({ error: "agentId is required." }, 400);
    }
    const [inputs, calibration] = await Promise.all([
      readAgentRiskInputs(agentId),
      readRiskCalibration(agentId),
    ]);
    return safJson({ inputs, calibration });
  } catch (error) {
    return safError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      agentId?: string;
      action?: "capture" | "probe" | "restore";
      candidate?: CalibrationCandidate;
    };
    const agentId = body.agentId?.trim();
    if (!agentId) {
      return safJson({ error: "agentId is required." }, 400);
    }
    if (body.action === "capture") {
      const calibration = await captureRiskBaseline(agentId);
      return safJson({ calibration, inputs: await readAgentRiskInputs(agentId) });
    }
    if (body.action === "probe" && body.candidate && CANDIDATES.has(body.candidate)) {
      const result = await probeRiskCandidate(agentId, body.candidate);
      return safJson({ calibration: result.calibration, inputs: result.observed });
    }
    if (body.action === "restore") {
      const result = await restoreRiskBaseline(agentId);
      return safJson({ calibration: result.calibration, inputs: result.observed });
    }
    return safJson({ error: "action must be capture, probe, or restore." }, 400);
  } catch (error) {
    return safError(error);
  }
}
