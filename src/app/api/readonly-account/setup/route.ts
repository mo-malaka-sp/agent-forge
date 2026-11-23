import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { safError, safJson } from "@/lib/saf-poc/http";
import { sailPointClientForDesk } from "@/lib/readonly-account/asana-desk";
import { setupTenant } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

async function POSTUnscoped() {
  try {
    // The tenant bound to SAF TestDrive Accounts (see the Tenants page).
    const result = await setupTenant(sailPointClientForDesk());
    return safJson(result, result.ok ? 200 : 400);
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
