import { tickAsanaAccounts } from "@/lib/readonly-account/asana";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!workerAuthorized(request.headers.get("x-agentforge-worker"))) {
    return safJson({ error: "Unauthorized." }, 401);
  }
  try {
    return safJson({ jobs: await tickAsanaAccounts() });
  } catch (error) {
    return safError(error);
  }
}
