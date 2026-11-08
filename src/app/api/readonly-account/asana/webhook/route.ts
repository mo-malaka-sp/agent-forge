import { NextResponse } from "next/server";

import { asanaAccessToken, loadAsanaDesk } from "@/lib/readonly-account/asana-desk";
import {
  acceptAsanaTask,
  commentAsanaOnce,
  declineAsanaTask,
  describeTaskStatus,
  resumeAsanaTask,
  writeTaskErrorNotes,
} from "@/lib/readonly-account/asana";
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
  let desk: Awaited<ReturnType<typeof loadAsanaDesk>>;
  try {
    desk = await loadAsanaDesk();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The back desk could not be read.";
    return NextResponse.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
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
      accept: async (taskGid) => {
        const status = await acceptAsanaTask(taskGid, { token, desk });
        if (status.failed) {
          await appendWebhookLog(store, `Task ${taskGid} was declined. ${status.detail}`);
        } else if (!status.done) {
          await appendWebhookLog(store, `Task ${taskGid} was not finished. ${status.detail}`);
        }
        return status;
      },
      record: (message) => appendWebhookLog(store, message).then(() => undefined),
      confirmStatus: async (taskGid) => {
        try {
          const status = await describeTaskStatus(taskGid, { token, desk });
          const normalized = status.toLowerCase();
          if (normalized === desk.triggerStatus.trim().toLowerCase()) {
            return true;
          }
          if (normalized === desk.workingStatus.trim().toLowerCase()) {
            const resumed = await resumeAsanaTask(taskGid, { token, desk });
            if (!resumed) {
              return `Task ${taskGid} is in "${status}". No account was saved to finish.`;
            }
            if (resumed.failed) {
              return `Task ${taskGid} was declined. ${resumed.detail}`;
            }
            if (!resumed.done) {
              return `Task ${taskGid} is in "${status}". ${resumed.detail}`;
            }
            return true;
          }
          return `Task ${taskGid} is in "${status || "blank"}".`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "The task status could not be read.";
          return `Task ${taskGid} was not read. ${message}`;
        }
      },
      reportFailure: async (taskGid, message) => {
        try {
          await writeTaskErrorNotes(taskGid, message, { token, desk });
        } catch {
          // The comment still records the error when the description update fails.
        }
        await commentAsanaOnce(taskGid, `SAF Test Drive\n${message}`, token);
        try {
          await declineAsanaTask(taskGid, { token, desk });
        } catch {
          // The comment already records the error when the status update fails.
        }
      },
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
