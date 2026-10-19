import { NextResponse } from "next/server";

import { createEnvironmentService, type EnvironmentService } from "@/lib/environments/service";

export function environmentJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

export function environmentError(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Environment request failed.";
  const status = /not found/i.test(message) ? 404 : 400;
  return environmentJson({ error: message }, status);
}

export function environmentService(): EnvironmentService {
  return createEnvironmentService();
}
