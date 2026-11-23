import { checkIscConnection, summarizeConnectionCheck } from "@/lib/isc/connection-check";
import { getProfile, recordProfileTest } from "@/lib/isc/profiles-store";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const profile = await getProfile(id);
    if (!profile) {
      return safJson({ error: "Tenant profile not found." }, 404);
    }
    const check = await checkIscConnection({
      tenant: profile.tenant,
      domain: profile.domain,
      clientId: profile.clientId,
      clientSecret: profile.clientSecret,
    });
    const summary = summarizeConnectionCheck(check);
    try {
      await recordProfileTest(id, { ok: check.ok, summary });
    } catch {
      // Deployed without a table, the result cannot be saved. The check itself still returns.
    }
    return safJson({ check, summary });
  } catch (error) {
    return safError(error);
  }
}
