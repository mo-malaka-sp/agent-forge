import { restoreAgentConditionRun } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { id?: string };
    if (!body.id) throw new Error("Run id is required.");
    return safJson({ run: await restoreAgentConditionRun(body.id) });
  } catch (error) {
    return safError(error);
  }
}
