import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  try {
    const { id, runId } = await context.params;
    return environmentJson({ run: await environmentService().getRun(id, runId) });
  } catch (error) {
    return environmentError(error);
  }
}
