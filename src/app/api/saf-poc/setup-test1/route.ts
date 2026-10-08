import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { safError, safJson, safPocResponse, saveWorkflowSetup } from "@/lib/saf-poc/http";
import { setupTest1 } from "@/lib/saf-poc/sailpoint";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { sendTest?: boolean };
    const setup = await setupTest1(loadSafPocConfig(), { sendTest: body.sendTest === true });
    await saveWorkflowSetup(setup);
    return safJson({
      setup,
      state: await safPocResponse(resolveBaseUrl(request.headers)),
    });
  } catch (error) {
    return safError(error);
  }
}
