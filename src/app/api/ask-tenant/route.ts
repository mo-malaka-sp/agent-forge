import { z } from "zod";

import { bedrockConverseFromEnv } from "@/lib/ask-tenant/bedrock";
import { answerAskedQuestion } from "@/lib/ask-tenant/compose";
import { liveAskDeps } from "@/lib/ask-tenant/tools";
import { withRequestIscRuntime } from "@/lib/isc/apply-runtime";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    const answer = await withRequestIscRuntime(request, undefined, () =>
      answerAskedQuestion(input.question, liveAskDeps(), bedrockConverseFromEnv()),
    );
    return safJson(answer);
  } catch (error) {
    return safError(error);
  }
}
