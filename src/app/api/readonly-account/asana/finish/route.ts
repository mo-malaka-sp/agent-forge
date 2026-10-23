import { finishPendingAsanaAccounts } from "@/lib/readonly-account/asana";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

export async function POST() {
  try {
    return safJson({ jobs: await finishPendingAsanaAccounts() });
  } catch (error) {
    return safError(error);
  }
}
