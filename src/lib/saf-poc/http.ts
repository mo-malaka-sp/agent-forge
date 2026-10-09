import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { timingSafeEqual } from "node:crypto";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { buildSafPocState } from "@/lib/saf-poc/events";
import { getSafPocStore } from "@/lib/saf-poc/storage";
import {
  readTransmitterSummary,
  type SsfResult,
} from "@/lib/saf-poc/transmitter";
import type { DatadogWorkflowSetup, WorkflowSetup } from "@/lib/saf-poc/sailpoint";

const WORKFLOW_KEY = "WORKFLOW#setup";
const DATADOG_WORKFLOW_KEY = "WORKFLOW#datadog";

export function safJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function safResult(result: SsfResult): NextResponse {
  if (result.empty || result.status === 204) {
    return new NextResponse(null, {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const response = safJson(result.body ?? {}, result.status);
  if (result.status === 401) {
    response.headers.set("WWW-Authenticate", "Bearer");
  }
  return response;
}

export function safError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return safJson(
      {
        error: "Event payload does not match the SAF contract.",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }
  const message = error instanceof Error ? error.message : "SAF POC request failed.";
  const status = /not found/i.test(message) ? 404 : 400;
  return safJson({ error: message }, status);
}

export function webhookAuthorized(headerValue: string | null): boolean {
  const expected = loadSafPocConfig().webhookToken;
  if (!expected) {
    return true;
  }
  const provided = headerValue?.trim() ?? "";
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export async function saveWorkflowSetup(setup: WorkflowSetup): Promise<void> {
  await getSafPocStore().put(WORKFLOW_KEY, setup);
}

export async function saveDatadogWorkflowSetup(
  setup: DatadogWorkflowSetup,
): Promise<void> {
  await getSafPocStore().put(DATADOG_WORKFLOW_KEY, setup);
}

export async function safPocResponse(baseUrl: string) {
  const [state, transmitter, workflow, datadogWorkflow] = await Promise.all([
    buildSafPocState(baseUrl),
    readTransmitterSummary(baseUrl),
    getSafPocStore().get<WorkflowSetup>(WORKFLOW_KEY),
    getSafPocStore().get<DatadogWorkflowSetup>(DATADOG_WORKFLOW_KEY),
  ]);
  return { ...state, transmitter, workflow, datadogWorkflow };
}
