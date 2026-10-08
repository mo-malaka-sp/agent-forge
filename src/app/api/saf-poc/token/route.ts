import { safError, safJson } from "@/lib/saf-poc/http";
import { readApiToken } from "@/lib/saf-poc/transmitter";

export const runtime = "nodejs";

export async function GET() {
  try {
    return safJson({ token: await readApiToken() });
  } catch (error) {
    return safError(error);
  }
}
