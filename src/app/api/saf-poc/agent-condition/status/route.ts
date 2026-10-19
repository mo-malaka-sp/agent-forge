import { getAgentConditionRun } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? undefined;
    return safJson({ run: await getAgentConditionRun(id) });
  } catch (error) {
    return safError(error);
  }
}
