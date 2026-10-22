import { z } from "zod";

import { safError, safJson } from "@/lib/saf-poc/http";
import { activateTestAccount, readonlyAccountClient } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

const activationSchema = z.object({
  userId: z.string().regex(/^[a-z0-9.]+$/),
  sourceId: z.string().min(1),
  profileId: z.string().min(1),
  activeStateId: z.string().min(1),
  identityNowSourceId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  password: z.string().min(8).max(64).optional(),
  passwordSet: z.boolean().optional(),
  passwordError: z.string().nullable().optional(),
  attempt: z.number().int().min(0).max(100),
  processed: z.boolean(),
});

export async function POST(request: Request) {
  try {
    const input = activationSchema.parse(await request.json());
    return safJson(await activateTestAccount(readonlyAccountClient(), input));
  } catch (error) {
    return safError(error);
  }
}
