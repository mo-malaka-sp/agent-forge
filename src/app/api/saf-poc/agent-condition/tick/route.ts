import {
  tickAgentConditionRuns,
  workerAuthorized,
} from "@/lib/saf-poc/agent-condition";
import { safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!workerAuthorized(request.headers.get("x-agentforge-worker"))) {
    return safJson({ error: "Unauthorized." }, 401);
  }
  const runs = await tickAgentConditionRuns();
  return safJson({ processed: runs.length });
}
