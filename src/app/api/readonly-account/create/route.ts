import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { z } from "zod";

import { safError, safJson } from "@/lib/saf-poc/http";
import { sailPointClientForDesk } from "@/lib/readonly-account/asana-desk";
import { createTestAccount } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

const createSchema = z.object({
  email: z.string().trim().max(254).optional(),
});

async function POSTUnscoped(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = createSchema.parse(body ?? {});
    const client = sailPointClientForDesk();
    return safJson(await createTestAccount(client, Math.random, input.email ?? ""));
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
