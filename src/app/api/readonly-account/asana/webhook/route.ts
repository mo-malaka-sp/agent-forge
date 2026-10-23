import { NextResponse } from "next/server";

import { acceptAsanaTask, commentAsanaOnce } from "@/lib/readonly-account/asana";
import {
  appendWebhookLog,
  defaultWebhookStore,
  readStashSecret,
  receiveAsanaWebhook,
  taskIsInSection,
  writeStashSecret,
} from "@/lib/readonly-account/asana-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "";
  const store = defaultWebhookStore();
  const result = await receiveAsanaWebhook(
    {
      hookSecret: request.headers.get("x-hook-secret"),
      signature: request.headers.get("x-hook-signature"),
      body: await request.text(),
      sectionGid: url.searchParams.get("section") ?? "",
      stashGid: url.searchParams.get("stash") ?? "",
    },
    {
      store,
      accept: acceptAsanaTask,
      record: (message) => appendWebhookLog(store, message).then(() => undefined),
      confirmSection: (taskGid, sectionGid) => taskIsInSection(token, taskGid, sectionGid),
      reportFailure: (taskGid, message) => commentAsanaOnce(taskGid, `SAF Test Drive\n${message}`, token),
      readSecret: (stashGid) => readStashSecret(token, stashGid),
      writeSecret: (stashGid, secret) => writeStashSecret(token, stashGid, secret),
    },
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
