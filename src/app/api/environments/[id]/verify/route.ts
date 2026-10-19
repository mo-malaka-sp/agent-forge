import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    return environmentJson(await environmentService().verify(id));
  } catch (error) {
    return environmentError(error);
  }
}
