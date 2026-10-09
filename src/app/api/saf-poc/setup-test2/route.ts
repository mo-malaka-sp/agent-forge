import { loadSafPocConfig } from "@/lib/saf-poc/config";
import {
  safError,
  safJson,
  safPocResponse,
  saveDatadogWorkflowSetup,
} from "@/lib/saf-poc/http";
import { setupTest2 } from "@/lib/saf-poc/sailpoint";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { sendTest?: boolean };
    const config = loadSafPocConfig();
    const setup = await setupTest2(config, {
      webhookUrl: `${resolveBaseUrl(request.headers)}/webhooks/saf`,
      webhookToken: config.webhookToken,
      sendTest: body.sendTest === true,
    });
    await saveDatadogWorkflowSetup(setup);
    return safJson({
      setup,
      state: await safPocResponse(resolveBaseUrl(request.headers)),
    });
  } catch (error) {
    return safError(error);
  }
}
