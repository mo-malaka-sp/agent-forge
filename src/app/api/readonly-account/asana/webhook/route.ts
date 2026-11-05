import { NextResponse } from "next/server";

import { asanaAccessToken, loadAsanaDesk } from "@/lib/readonly-account/asana-desk";
import { acceptAsanaTask, commentAsanaOnce, describeTaskStatus } from "@/lib/readonly-account/asana";
import {
  appendWebhookLog,
  defaultWebhookStore,
  readStashSecret,
  receiveAsanaWebhook,
  writeStashSecret,
} from "@/lib/readonly-account/asana-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const desk = loadAsanaDesk();
  const token = asanaAccessToken(undefined, desk);
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
      confirmStatus: async (taskGid) => {
        try {
          const status = await describeTaskStatus(taskGid, { token, desk });
          if (status.toLowerCase() === desk.triggerStatus.trim().toLowerCase()) {
            return true;
          }
          return `Task ${taskGid} is in "${status || "blank"}".`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "The task status could not be read.";
          return `Task ${taskGid} was not read. ${message}`;
        }
      },
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
