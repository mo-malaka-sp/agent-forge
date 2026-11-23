import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { jsonError, jsonValidationError } from "@/lib/api/response";
import {
  applyPrivilegeCriteriaGolden,
  loadPrivilegeCriteriaGolden,
} from "@/lib/isc/privilege-criteria";
import {
  assertIscTargetAuth,
  resolveIscTargetAuth,
} from "@/lib/isc/resolve-target-auth";
import { iscPrivilegeClassificationApplySchema } from "@/lib/validation/setup.schema";

const PLATFORM_BY_SLUG = {
  "aws-bedrock": "aws_bedrock",
  "gcp-vertex": "gcp_vertex",
  "azure-ai-foundry": "azure_ai_foundry",
} as const;

export const runtime = "nodejs";

async function POSTUnscoped(request: Request) {
  try {
    const raw = await request.json();

    return await withRequestIscRuntime(request, raw, async () => {
      try {
        const payload = iscPrivilegeClassificationApplySchema.parse(raw);
        const platform = PLATFORM_BY_SLUG[payload.connector_slug];
        const golden = await loadPrivilegeCriteriaGolden(platform);

        if (!golden) {
          return jsonError(
            `Golden privilege classification for "${payload.connector_slug}" is not published. Maintainer must run scripts/export-privilege-criteria.mjs and commit config/isc/golden/privilege-classification.*.json`,
            404,
          );
        }

        const auth = resolveIscTargetAuth({
          tenant: payload.tenant,
          domain: payload.domain,
          personalAccessToken: payload.personal_access_token,
          clientId: payload.client_id,
          clientSecret: payload.client_secret,
        });
        assertIscTargetAuth(auth);

        const result = await applyPrivilegeCriteriaGolden({
          target: {
            tenant: auth.tenant,
            domain: auth.domain,
            personalAccessToken: auth.personalAccessToken,
            clientId: auth.clientId,
            clientSecret: auth.clientSecret,
          },
          sourceId: payload.source_id,
          golden,
        });

        return NextResponse.json({
          ok: true,
          connector_slug: payload.connector_slug,
          source_id: payload.source_id,
          ...result,
          message:
            "Privilege classification applied. Re-run outboundPermissions and inboundCallers entitlement aggregation in ISC.",
        });
      } catch (error) {
        if (error instanceof ZodError) {
          return jsonValidationError(error);
        }

        const message =
          error instanceof Error
            ? error.message
            : "Failed to apply privilege classification";
        console.error("Privilege classification apply failed:", message);
        return jsonError(message, 502);
      }
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    const message =
      error instanceof Error
        ? error.message
        : "Failed to apply privilege classification";
    console.error("Privilege classification apply failed:", message);
    return jsonError(message, 502);
  }
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
