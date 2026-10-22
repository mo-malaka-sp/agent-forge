import { safError, safJson } from "@/lib/saf-poc/http";
import { createTestAccount, readonlyAccountClient } from "@/lib/readonly-account/tenant";

export const runtime = "nodejs";

export async function POST() {
  try {
    return safJson(await createTestAccount(readonlyAccountClient()));
  } catch (error) {
    return safError(error);
  }
}
