import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { safError, safJson } from "@/lib/saf-poc/http";
import { publishRiskLevelChange } from "@/lib/saf-poc/transmitter";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      previousLevel?: string;
      currentLevel?: string;
    };
    const config = loadSafPocConfig();
    const result = await publishRiskLevelChange({
      publicUrl: resolveBaseUrl(request.headers),
      email: body.email?.trim() || config.notifyEmail,
      previousLevel: body.previousLevel || "LOW",
      currentLevel: body.currentLevel || "HIGH",
    });
    return safJson(result, 202);
  } catch (error) {
    return safError(error);
  }
}
