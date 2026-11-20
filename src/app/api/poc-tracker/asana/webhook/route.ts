import { NextResponse } from "next/server";

import {
  appendPocTrackerLog,
  loadPocTracker,
  pocTrackerWebhookStore,
  sharedAsanaToken,
} from "@/lib/poc-tracker/store";
import { receivePocTrackerWebhook } from "@/lib/poc-tracker/webhook";
import { describeSlackSyncResult, syncAsanaSlackStatus } from "@/lib/readonly-account/asana-slack-sync";
import { readStashSecret, writeStashSecret } from "@/lib/readonly-account/asana-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const url = new URL(request.url);
  let token: string;
  try {
    token = await sharedAsanaToken();
  } catch (error) {
    const message = error instanceof Error ? error.message : "The back desk could not be read.";
    return NextResponse.json({ error: message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const store = pocTrackerWebhookStore();
  const body = await request.text();
  const result = await receivePocTrackerWebhook(
    {
      hookSecret: request.headers.get("x-hook-secret"),
      signature: request.headers.get("x-hook-signature"),
      body,
      stashGid: url.searchParams.get("stash") ?? "",
    },
    {
      store,
      record: (message) => appendPocTrackerLog(message),
      readSecret: (stashGid) => readStashSecret(token, stashGid),
      writeSecret: (stashGid, secret) => writeStashSecret(token, stashGid, secret),
    },
  );
  if (result.status === 200 && result.taskGids.length > 0) {
    try {
      const current = await loadPocTracker();
      const outcomes = await syncAsanaSlackStatus(result.taskGids, {
        asanaToken: token,
        projectGid: current.projectGid,
        slackToken: current.slackBotToken.trim() || undefined,
        channelId: current.channelId.trim() || undefined,
      });
      for (const outcome of outcomes) {
        await appendPocTrackerLog(describeSlackSyncResult(outcome));
      }
    } catch {
      await appendPocTrackerLog("Slack sync failed.");
    }
  }
  return new NextResponse(result.body ? JSON.stringify(result.body) : null, {
    status: result.status,
    headers: {
      "Cache-Control": "no-store",
      ...(result.body ? { "Content-Type": "application/json" } : {}),
      ...result.headers,
    },
  });
}
