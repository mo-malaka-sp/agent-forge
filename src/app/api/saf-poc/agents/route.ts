import { safError, safJson } from "@/lib/saf-poc/http";
import { listTenantAgents } from "@/lib/saf-poc/tenant-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const agents = await listTenantAgents();
    return safJson({ agents });
  } catch (error) {
    return safError(error);
  }
}
