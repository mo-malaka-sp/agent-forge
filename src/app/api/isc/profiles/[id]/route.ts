import { clearFeatureTenantCache } from "@/lib/isc/feature-tenant";
import { parseProfileBody } from "@/lib/isc/profile-api";
import { deleteProfile, saveProfile } from "@/lib/isc/profiles-store";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const input = parseProfileBody(await request.json());
    const profile = await saveProfile(input, { id });
    clearFeatureTenantCache();
    return safJson({ profile });
  } catch (error) {
    return safError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    await deleteProfile(id);
    clearFeatureTenantCache();
    return safJson({ deleted: id });
  } catch (error) {
    return safError(error);
  }
}
