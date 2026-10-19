import { environmentError, environmentJson, environmentService } from "@/lib/environments/http";
import type { CreateEnvironmentInput } from "@/lib/environments/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    return environmentJson({ environments: await environmentService().list() });
  } catch (error) {
    return environmentError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateEnvironmentInput;
    return environmentJson({ environment: await environmentService().create(body) }, 201);
  } catch (error) {
    return environmentError(error);
  }
}
