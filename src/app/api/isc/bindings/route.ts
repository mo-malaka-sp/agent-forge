import { clearFeatureTenantCache } from "@/lib/isc/feature-tenant";
import { parseBindingBody } from "@/lib/isc/profile-api";
import { getBindings, setBinding } from "@/lib/isc/profiles-store";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    return safJson({ bindings: await getBindings() });
  } catch (error) {
    return safError(error);
  }
}

/** Points one feature at a saved tenant. `profileId: null` clears the feature's own binding. */
export async function PUT(request: Request) {
  try {
    const { feature, profileId } = parseBindingBody(await request.json());
    const bindings = await setBinding(feature, profileId);
    clearFeatureTenantCache();
    return safJson({ bindings });
  } catch (error) {
    return safError(error);
  }
}
