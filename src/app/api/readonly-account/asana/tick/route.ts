import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { tickAsanaAccounts } from "@/lib/readonly-account/asana";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  if (!workerAuthorized(request.headers.get("x-agentforge-worker"))) {
    return safJson({ error: "Unauthorized." }, 401);
  }
  try {
    return safJson({ jobs: await tickAsanaAccounts() });
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
