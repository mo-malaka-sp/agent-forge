import { safError, safJson, safPocResponse } from "@/lib/saf-poc/http";
import { changeAgentRisk } from "@/lib/saf-poc/risk";
import { resolveBaseUrl } from "@/lib/url";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      agentId?: string;
      agentName?: string;
      riskLevel?: string;
      previousLevel?: string;
      identityEmail?: string;
      transmit?: boolean;
      ingest?: boolean;
    };
    if (!body.agentId?.trim() || !body.riskLevel?.trim()) {
      return safJson({ error: "agentId and riskLevel are required." }, 400);
    }
    const baseUrl = resolveBaseUrl(request.headers);
    const result = await changeAgentRisk({
      agentId: body.agentId,
      agentName: body.agentName,
      riskLevel: body.riskLevel,
      previousLevel: body.previousLevel,
      identityEmail: body.identityEmail,
      publicUrl: baseUrl,
      transmit: body.transmit,
      ingest: body.ingest,
    });
    return safJson({ result, state: await safPocResponse(baseUrl) });
  } catch (error) {
    return safError(error);
  }
}
