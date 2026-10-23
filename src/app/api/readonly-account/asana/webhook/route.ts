import { NextResponse } from "next/server";

import { acceptAsanaTask } from "@/lib/readonly-account/asana";
import { defaultWebhookStore, receiveAsanaWebhook } from "@/lib/readonly-account/asana-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await receiveAsanaWebhook(
    {
      hookSecret: request.headers.get("x-hook-secret"),
      signature: request.headers.get("x-hook-signature"),
      body: await request.text(),
    },
    { store: defaultWebhookStore(), accept: acceptAsanaTask },
  );
  return new NextResponse(result.body ? JSON.stringify(result.body) : null, {
    status: result.status,
    headers: {
      "Cache-Control": "no-store",
      ...(result.body ? { "Content-Type": "application/json" } : {}),
      ...result.headers,
    },
  });
}
