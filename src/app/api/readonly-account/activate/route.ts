import { withFeatureTenant } from "@/lib/isc/feature-tenant";
import { z } from "zod";

import { safError, safJson } from "@/lib/saf-poc/http";
import { sailPointClientForDesk } from "@/lib/readonly-account/asana-desk";
import { activateTestAccount } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

const activationSchema = z.object({
  userId: z.string().regex(/^[a-z0-9.]+$/),
  accountName: z.string().trim().min(1).max(254).optional(),
  sourceName: z.string().trim().min(1).max(128).optional(),
  sourceId: z.string().min(1),
  profileId: z.string().min(1),
  activeStateId: z.string().min(1),
  identityNowSourceId: z.string().min(1),
  taskId: z.string().min(1).nullable().optional(),
  password: z.string().min(8).max(64).optional(),
  passwordSet: z.boolean().optional(),
  passwordError: z.string().nullable().optional(),
  redirectEmail: z.string().trim().max(254).optional(),
  inviteSent: z.boolean().optional(),
  inviteError: z.string().nullable().optional(),
  attempt: z.number().int().min(0).max(100),
  processed: z.boolean(),
});

async function POSTUnscoped(request: Request) {
  try {
    const input = activationSchema.parse(await request.json());
    const client = sailPointClientForDesk();
    return safJson(await activateTestAccount(client, input));
  } catch (error) {
    return safError(error);
  }
}

export const POST = withFeatureTenant("test-drive", POSTUnscoped);
