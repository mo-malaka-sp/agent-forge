import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { safError, safJson } from "@/lib/saf-poc/http";
import { listTenantAgents } from "@/lib/saf-poc/tenant-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function GETUnscoped() {
  try {
    const agents = await listTenantAgents();
    return safJson({ agents });
  } catch (error) {
    return safError(error);
  }
}

export const GET = withFeatureTenant("endpoint", GETUnscoped);
