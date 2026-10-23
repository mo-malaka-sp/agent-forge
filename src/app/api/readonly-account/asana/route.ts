import { z } from "zod";

import { acceptAsanaTask } from "@/lib/readonly-account/asana";
import { workerAuthorized } from "@/lib/saf-poc/agent-condition";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

const requestSchema = z.object({
  taskGid: z.string().trim().min(1),
});

// Machine caller for one Asana task. The project webhook is the normal trigger.
// Header x-agentforge-worker: <SAF_POC_WORKER_TOKEN>
// Body { "taskGid": "<asana task gid>" }
// POST /api/readonly-account/asana/tick finishes invitations Amplify could not hold open.
export async function POST(request: Request) {
  if (!workerAuthorized(request.headers.get("x-agentforge-worker"))) {
    return safJson({ error: "Unauthorized." }, 401);
  }
  try {
    const input = requestSchema.parse(await request.json());
    return safJson(await acceptAsanaTask(input.taskGid), 202);
  } catch (error) {
    return safError(error);
  }
}
