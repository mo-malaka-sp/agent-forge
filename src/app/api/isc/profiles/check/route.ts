import { checkIscConnection, summarizeConnectionCheck } from "@/lib/isc/connection-check";
import { parseProfileBody } from "@/lib/isc/profile-api";
import { getProfile } from "@/lib/isc/profiles-store";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

/**
 * Checks a tenant the form is holding before it is saved. Nothing is written. When an `id` is
 * given and the secret is left blank, the saved secret is used.
 */
export async function POST(request: Request) {
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id ? raw.id : null;
    const input = parseProfileBody(raw);
    const saved = id ? await getProfile(id) : null;
    if (id && !saved) {
      return safJson({ error: "Tenant profile not found." }, 404);
    }
    const check = await checkIscConnection({
      tenant: input.tenant,
      domain: input.domain ?? saved?.domain ?? "identitynow.com",
      clientId: input.clientId,
      clientSecret: input.clientSecret ?? saved?.clientSecret ?? "",
    });
    return safJson({ check, summary: summarizeConnectionCheck(check) });
  } catch (error) {
    return safError(error);
  }
}
