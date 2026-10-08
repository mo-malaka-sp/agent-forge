import { safJson } from "@/lib/saf-poc/http";
import { readTransmitterPublicKey } from "@/lib/saf-poc/transmitter";

export const runtime = "nodejs";

export async function GET() {
  return safJson({ keys: [await readTransmitterPublicKey()] });
}
