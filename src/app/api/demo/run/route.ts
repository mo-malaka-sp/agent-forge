import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { runDemoStep } from "@/lib/demo/orchestrator";
import { DEMO_MODES, getDemoCatalog, getNextStep, type DemoModeId } from "@/lib/demo/steps";
import { jsonError, jsonValidationError } from "@/lib/api/response";
import { resolveBaseUrl } from "@/lib/url";
import { demoStepSchema } from "@/lib/validation/demo.schema";

export const runtime = "nodejs";

async function POSTUnscoped(request: NextRequest) {
  try {
    const raw = await request.json();
    const body = demoStepSchema.parse(raw);
    const baseUrl = resolveBaseUrl(request.headers);

    const result = await withRequestIscRuntime(request, raw, async () =>
      runDemoStep(body, baseUrl),
    );
    const mode = (request.nextUrl.searchParams.get("mode") ??
      null) as DemoModeId | null;
    const nextStep =
      mode && mode in DEMO_MODES ? getNextStep(mode, body.step) : null;

    return NextResponse.json({
      ...result,
      nextStep,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return jsonValidationError(error);
    }

    console.error("POST /api/demo/run failed:", error);
    return jsonError(
      error instanceof Error ? error.message : "Demo step failed",
      500,
    );
  }
}

async function GETUnscoped() {
  return NextResponse.json(getDemoCatalog());
}

export const POST = withFeatureTenant("govern", POSTUnscoped);
export const GET = withFeatureTenant("govern", GETUnscoped);
