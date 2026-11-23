import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { NextResponse } from "next/server";

import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { getAnyIscConfig } from "@/lib/isc/config";
import {
  getTaskStatus,
  isTaskComplete,
  isTaskSuccessful,
  formatTaskStatus,
  formatTaskErrors,
} from "@/lib/isc/tasks";
import { jsonError } from "@/lib/api/response";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ taskId: string }>;
};

async function GETUnscoped(request: Request, context: RouteContext) {
  try {
    return await withRequestIscRuntime(request, undefined, async () => {
      const config = getAnyIscConfig();
      if (!config) {
        return jsonError(
          "ISC is not configured. Save tenant connection and source IDs on the Demo page, then try again.",
          503,
        );
      }

      const { taskId } = await context.params;
      const status = await getTaskStatus(config, taskId);

      return NextResponse.json({
        taskId,
        complete: isTaskComplete(status),
        successful: isTaskSuccessful(status),
        label: formatTaskStatus(status),
        errorDetail: formatTaskErrors(status),
        status,
      });
    });
  } catch (error) {
    console.error("GET /api/demo/task/[taskId] failed:", error);
    return jsonError(
      error instanceof Error ? error.message : "Failed to fetch task status",
      500,
    );
  }
}

export const GET = withFeatureTenant("govern", GETUnscoped);
