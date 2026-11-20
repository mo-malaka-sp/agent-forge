import { z } from "zod";

import {
  appendPocTrackerLog,
  loadPocTracker,
  POC_TRACKER_WEBHOOK_PATH,
  pocTrackerPublic,
  pocTrackerStorage,
  pocTrackerWebhookStore,
  savePocTracker,
  sharedAsanaToken,
  sharedAsanaTokenSource,
} from "@/lib/poc-tracker/store";
import { registerProjectWebhook } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

const trackerSchema = z.object({
  slackBotToken: z.string().optional(),
  projectName: z.string().optional(),
  channelId: z.string().optional(),
});

export async function GET() {
  try {
    const config = await loadPocTracker();
    const source = await sharedAsanaTokenSource();
    return safJson({ tracker: pocTrackerPublic(config, source), storage: pocTrackerStorage() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SAF POC Tracker could not be read.";
    return safJson({ error: message, storage: pocTrackerStorage() }, 503);
  }
}

export async function POST(request: Request) {
  try {
    const input = trackerSchema.parse(await request.json());
    const saved = await savePocTracker({
      slackBotToken: input.slackBotToken,
      projectName: input.projectName,
      channelId: input.channelId,
    });
    const token = await sharedAsanaToken();
    if (!token) {
      return safJson(
        {
          tracker: pocTrackerPublic(saved, "missing"),
          webhookError:
            "No Asana access token. Save it on SAF TestDrive Accounts or set ASANA_ACCESS_TOKEN. SAF POC Tracker uses that token.",
        },
        400,
      );
    }
    const targetUrl = `${resolveBaseUrl(request.headers)}${POC_TRACKER_WEBHOOK_PATH}`;
    try {
      const webhook = await registerProjectWebhook({
        token,
        projectName: saved.projectName,
        targetUrl,
        store: pocTrackerWebhookStore(),
        hookPath: POC_TRACKER_WEBHOOK_PATH,
      });
      await appendPocTrackerLog(`Connected to ${webhook.projectName}.`);
      const config = await loadPocTracker();
      return safJson({
        tracker: pocTrackerPublic(config, await sharedAsanaTokenSource()),
        webhook,
        storage: pocTrackerStorage(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asana webhook registration failed.";
      await appendPocTrackerLog(`Connect failed. ${message}`);
      return safJson({
        tracker: pocTrackerPublic(await loadPocTracker(), await sharedAsanaTokenSource()),
        webhookError: message,
        storage: pocTrackerStorage(),
      });
    }
  } catch (error) {
    return safError(error);
  }
}
