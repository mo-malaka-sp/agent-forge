import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { confirm?: string };
    const result = await environmentService().requestCleanup(id, body.confirm ?? "");
    return environmentJson(result, result.accepted ? 202 : 400);
  } catch (error) {
    return environmentError(error);
  }
}
