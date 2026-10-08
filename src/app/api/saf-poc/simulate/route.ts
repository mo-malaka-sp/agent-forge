import { buildFixture, ingestSafEvent, runFullDemo } from "@/lib/saf-poc/events";
import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCENARIOS = [
  "risk-state-changed",
  "exposed-credential",
  "critical-escalation",
] as const;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { scenario?: string };
    const scenario = body.scenario?.trim() ?? "";
    if (scenario === "full-demo") {
      await runFullDemo();
    } else if (SCENARIOS.includes(scenario as (typeof SCENARIOS)[number])) {
      await ingestSafEvent({
        payload: buildFixture(scenario as (typeof SCENARIOS)[number]),
        source: "simulator",
        scenario,
      });
    } else {
      return safJson(
        {
          error:
            "Choose a scenario: risk-state-changed, exposed-credential, critical-escalation, or full-demo.",
        },
        400,
      );
    }
    return safJson(await safPocResponse(resolveBaseUrl(request.headers)));
  } catch (error) {
    return safError(error);
  }
}
