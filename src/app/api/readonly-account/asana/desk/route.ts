import { z } from "zod";

import {
  asanaDeskPublic,
  loadAsanaDesk,
  saveAsanaDesk,
} from "@/lib/readonly-account/asana-desk";
import { defaultWebhookStore, registerProjectWebhook } from "@/lib/readonly-account/asana-webhook";
import { safError, safJson } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

const deskSchema = z.object({
  asanaToken: z.string().optional(),
  tenant: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  projectName: z.string().optional(),
  triggerStatus: z.string().optional(),
  workingStatus: z.string().optional(),
  doneStatus: z.string().optional(),
  declinedStatus: z.string().optional(),
  accountField: z.string().optional(),
  codeField: z.string().optional(),
  tenantLinkField: z.string().optional(),
  tenantLinkTemplate: z.string().optional(),
});

export async function GET() {
  return safJson({ desk: asanaDeskPublic(loadAsanaDesk()) });
}

export async function POST(request: Request) {
  try {
    const input = deskSchema.parse(await request.json());
    const saved = saveAsanaDesk(input);
    const targetUrl = `${resolveBaseUrl(request.headers)}/api/readonly-account/asana/webhook`;
    try {
      const webhook = await registerProjectWebhook({
        token: saved.asanaToken,
        projectName: saved.projectName,
        targetUrl,
        store: defaultWebhookStore(),
      });
      return safJson({ desk: asanaDeskPublic(saved), webhook });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Asana webhook registration failed.";
      return safJson({ desk: asanaDeskPublic(saved), webhookError: message });
    }
  } catch (error) {
    return safError(error);
  }
}
