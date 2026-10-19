import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { repair?: boolean };
    return environmentJson(
      { run: await environmentService().startRun(id, Boolean(body.repair)) },
      201,
    );
  } catch (error) {
    return environmentError(error);
  }
}
