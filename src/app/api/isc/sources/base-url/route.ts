import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { jsonError, jsonValidationError } from "@/lib/api/response";
import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { getIscCredentials, getIscSourceId } from "@/lib/isc/config";
import {
  isUnreachableBaseUrl,
  readSourceBaseUrl,
  repairSourceBaseUrl,
} from "@/lib/isc/source-base-url";
import { DEPLOYMENT_PROVIDER_VALUES } from "@/lib/providers/profiles";
import { resolveBaseUrl } from "@/lib/url";
import { iscSourceBaseUrlRepairSchema } from "@/lib/validation/isc.schema";

export const runtime = "nodejs";

/** Report the callback base URL stored on every configured Web Services source. */
export async function GET(request: Request) {
  const expectedBaseUrl = resolveBaseUrl(request.headers);

  try {
    const credentials = getIscCredentials();
    if (!credentials) {
      return jsonError("ISC credentials are not configured.", 400);
    }

    const sources = await Promise.all(
      DEPLOYMENT_PROVIDER_VALUES.map(async (provider) => {
        const sourceId = getIscSourceId(provider);
        if (!sourceId) {
          return { provider, sourceId: null };
        }

        try {
          const state = await readSourceBaseUrl(
            { ...credentials, sourceId },
            expectedBaseUrl,
          );
          return {
            provider,
            ...state,
            matches:
              state.baseUrl !== null &&
              state.baseUrl.replace(/\/$/, "") ===
                expectedBaseUrl.replace(/\/$/, ""),
          };
        } catch (error) {
          return {
            provider,
            sourceId,
            error:
              error instanceof Error ? error.message : "Could not read source",
          };
        }
      }),
    );

    return NextResponse.json({
      expectedBaseUrl,
      expectedBaseUrlReachable: !isUnreachableBaseUrl(expectedBaseUrl),
      sources,
    });
  } catch (error) {
    console.error("GET /api/isc/sources/base-url failed:", error);
    return jsonError("Failed to read source base URLs", 500);
  }
}

/** Repoint an imported source at this AgentForge deployment. */
export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const body = iscSourceBaseUrlRepairSchema.parse(raw);
    const expectedBaseUrl = body.base_url?.trim() || resolveBaseUrl(request.headers);

    if (isUnreachableBaseUrl(expectedBaseUrl)) {
      return jsonError(
        `Refusing to write ${expectedBaseUrl} to ISC — this deployment resolves to a local address that the tenant cannot reach. Set AGENTFORGE_BASE_URL to the public URL and retry.`,
        400,
      );
    }

    const result = await withRequestIscRuntime(request, body, async () => {
      const credentials = getIscCredentials();
      if (!credentials) {
        throw new Error("ISC credentials are not configured.");
      }

      const sourceId = body.source_id?.trim() || getIscSourceId(body.provider);
      if (!sourceId) {
        throw new Error(`No source ID saved for ${body.provider}.`);
      }

      return repairSourceBaseUrl({ ...credentials, sourceId }, expectedBaseUrl);
    });

    return NextResponse.json({
      provider: body.provider,
      ...result,
      message: result.changed
        ? `Base URL updated from ${result.previousBaseUrl} to ${result.expectedBaseUrl}. Run Test Connection in ISC to clear the "Not Responding" status.`
        : `Base URL was already ${result.expectedBaseUrl}.`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    const message =
      error instanceof Error ? error.message : "Failed to repair source base URL";
    console.error("POST /api/isc/sources/base-url failed:", message);
    return jsonError(message, 502);
  }
}
