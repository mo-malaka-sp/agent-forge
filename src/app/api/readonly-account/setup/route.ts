import { safError, safJson } from "@/lib/saf-poc/http";
import { readonlyAccountClient, setupTenant } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

export async function POST() {
  try {
    const result = await setupTenant(readonlyAccountClient());
    return safJson(result, result.ok ? 200 : 400);
  } catch (error) {
    return safError(error);
  }
}
