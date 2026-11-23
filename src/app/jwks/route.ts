import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { safJson } from "@/lib/saf-poc/http";
import { readTransmitterPublicKey } from "@/lib/saf-poc/transmitter";

export const runtime = "nodejs";

async function GETUnscoped() {
  return safJson({ keys: [await readTransmitterPublicKey()] });
}

export const GET = withFeatureTenant("caep", GETUnscoped);
