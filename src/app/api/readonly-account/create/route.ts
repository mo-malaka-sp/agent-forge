import { z } from "zod";

import { safError, safJson } from "@/lib/saf-poc/http";
import { createTestAccount, readonlyAccountClient } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

const createSchema = z.object({
  email: z.string().trim().max(254).optional(),
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const input = createSchema.parse(body ?? {});
    return safJson(await createTestAccount(readonlyAccountClient(), Math.random, input.email ?? ""));
  } catch (error) {
    return safError(error);
  }
}
