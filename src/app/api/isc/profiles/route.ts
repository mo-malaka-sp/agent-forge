import { clearFeatureTenantCache } from "@/lib/isc/feature-tenant";
import {
  durableStorageProblem,
  ensureLegacyTenantsMigrated,
  getBindings,
  listProfiles,
  saveProfile,
  TENANT_FEATURE_LABELS,
  TENANT_FEATURES,
  toPublicProfile,
} from "@/lib/isc/profiles-store";
import { parseProfileBody } from "@/lib/isc/profile-api";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    await ensureLegacyTenantsMigrated();
    const [profiles, bindings] = await Promise.all([listProfiles(), getBindings()]);
    return safJson({
      profiles: profiles.map(toPublicProfile),
      bindings,
      features: TENANT_FEATURES.map((id) => ({ id, label: TENANT_FEATURE_LABELS[id] })),
      storageProblem: durableStorageProblem(),
    });
  } catch (error) {
    return safError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = parseProfileBody(await request.json());
    const profile = await saveProfile(input);
    clearFeatureTenantCache();
    return safJson({ profile }, 201);
  } catch (error) {
    return safError(error);
  }
}
