import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const service = environmentService();
    const [environment, run] = await Promise.all([service.get(id), service.latestRun(id)]);
    return environmentJson({ environment, run });
  } catch (error) {
    return environmentError(error);
  }
}
