import { z } from "zod";

import { answerQuestion, liveAskDeps } from "@/lib/ask-tenant/tools";
import { safError, safJson } from "@/lib/saf-poc/http";

export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().trim().min(1).max(500),
});

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    return safJson(await answerQuestion(input.question, liveAskDeps()));
  } catch (error) {
    return safError(error);
  }
}
