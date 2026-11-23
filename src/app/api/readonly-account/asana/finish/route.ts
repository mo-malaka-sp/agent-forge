import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { finishPendingAsanaAccounts } from "@/lib/readonly-account/asana";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

async function POSTUnscoped() {
  try {
    return safJson({ jobs: await finishPendingAsanaAccounts() });
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
