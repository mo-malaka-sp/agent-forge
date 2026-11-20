import { z } from "zod";

import {
  appendPocTrackerLog,
  loadPocTracker,
  pocTrackerPublic,
  pocTrackerStorage,
  pocTrackerWebhookStore,
  POC_TRACKER_WEBHOOK_PATH,
  savePocTracker,
} from "@/lib/poc-tracker/store";
import { registerProjectWebhook } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

const trackerSchema = z.object({
  asanaToken: z.string().optional(),
  slackBotToken: z.string().optional(),
  projectName: z.string().optional(),
  channelId: z.string().optional(),
});

export async function GET() {
  try {
    const config = await loadPocTracker();
    return safJson({ tracker: pocTrackerPublic(config), storage: pocTrackerStorage() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SAF POC Tracker could not be read.";
    return safJson({ error: message, storage: pocTrackerStorage() }, 503);
  }
}

export async function POST(request: Request) {
  try {
    const input = trackerSchema.parse(await request.json());
    const saved = await savePocTracker({
      asanaToken: input.asanaToken,
      slackBotToken: input.slackBotToken,
      projectName: input.projectName,
      channelId: input.channelId,
    });
    if (!saved.asanaToken.trim()) {
      return safJson({ tracker: pocTrackerPublic(saved), webhookError: "Enter the Asana access token." }, 400);
    }
    const targetUrl = `${resolveBaseUrl(request.headers)}${POC_TRACKER_WEBHOOK_PATH}`;
    try {
      const webhook = await registerProjectWebhook({
        token: saved.asanaToken,
        projectName: saved.projectName,
        targetUrl,
        store: pocTrackerWebhookStore(),
        hookPath: POC_TRACKER_WEBHOOK_PATH,
      });
      await appendPocTrackerLog(`Connected to ${webhook.projectName}.`);
      const config = await loadPocTracker();
      return safJson({ tracker: pocTrackerPublic(config), webhook, storage: pocTrackerStorage() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asana webhook registration failed.";
      await appendPocTrackerLog(`Connect failed. ${message}`);
      return safJson({
        tracker: pocTrackerPublic(await loadPocTracker()),
        webhookError: message,
        storage: pocTrackerStorage(),
      });
    }
  } catch (error) {
    return safError(error);
  }
}
