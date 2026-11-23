import { withFeatureTenant, clearFeatureTenantCache } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { jsonError, jsonValidationError } from "@/lib/api/response";
import { getIscPublicStatus } from "@/lib/isc/config";
import { updateProfileSources } from "@/lib/isc/profiles-store";
import { getActiveIscRuntime } from "@/lib/isc/runtime-config";
import {
  getActiveSourceStrings,
  readIscSettings,
  updateIscSettings,
} from "@/lib/isc/settings-store";
import { DEPLOYMENT_PROVIDERS } from "@/lib/providers/profiles";
import { iscSourcesUpdateSchema } from "@/lib/validation/isc.schema";

export const runtime = "nodejs";

async function GETUnscoped() {
  // Source IDs belong to the tenant in effect: the bound profile, or the global settings.
  const settings = readIscSettings();
  const status = getIscPublicStatus();
  const sources = getActiveSourceStrings();

  return NextResponse.json({
    credentialsConfigured: status.credentialsConfigured,
    tenant: status.tenant,
    sources,
    misSchemas: settings.misSchemas,
    datasetIds: settings.misSchemas,
    updatedAt: settings.updatedAt,
    platforms: Object.entries(DEPLOYMENT_PROVIDERS).map(([id, profile]) => ({
      provider: id,
      label: profile.label,
      defaultMisSchemaId: profile.misSchemaId,
      defaultDatasetId: profile.misSchemaId,
      sourceId: sources[id as keyof typeof sources] ?? "",
      misSchemaId: settings.misSchemas[id as keyof typeof settings.misSchemas] ?? "",
      datasetId: settings.misSchemas[id as keyof typeof settings.misSchemas] ?? "",
    })),
  });
}

async function PUTUnscoped(request: Request) {
  try {
    const body = iscSourcesUpdateSchema.parse(await request.json());
    if (!body.sources && !body.mis_schemas && !body.dataset_ids) {
      return jsonError("sources, mis_schemas, or dataset_ids object is required", 400);
    }
    const misSchemas = body.dataset_ids ?? body.mis_schemas;
    const bound = getActiveIscRuntime();

    if (bound?.profile_id) {
      // Source IDs are saved on the bound tenant, so another tenant never sees them.
      const updated = body.sources
        ? await updateProfileSources(bound.profile_id, body.sources)
        : null;
      const settings = misSchemas ? updateIscSettings({ misSchemas }) : readIscSettings();
      clearFeatureTenantCache();
      const sources = updated
        ? {
            aws_bedrock: updated.sources.aws_bedrock ?? "",
            gcp_vertex: updated.sources.gcp_vertex ?? "",
            azure_ai_foundry: updated.sources.azure_ai_foundry ?? "",
          }
        : getActiveSourceStrings();
      return NextResponse.json({
        ok: true,
        sources,
        misSchemas: settings.misSchemas,
        datasetIds: settings.misSchemas,
        updatedAt: new Date().toISOString(),
      });
    }

    const settings = updateIscSettings({
      sources: body.sources,
      misSchemas,
    });

    return NextResponse.json({
      ok: true,
      sources: settings.sources,
      misSchemas: settings.misSchemas,
      datasetIds: settings.misSchemas,
      updatedAt: settings.updatedAt,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    console.error("PUT /api/isc/sources failed:", error);
    return jsonError("Failed to save ISC source settings", 500);
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
export const PUT = withFeatureTenant("govern", PUTUnscoped);
