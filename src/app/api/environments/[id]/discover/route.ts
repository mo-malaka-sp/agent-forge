import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return environmentJson({ agents: await environmentService().discover(id) });
  } catch (error) {
    return environmentError(error);
  }
}
