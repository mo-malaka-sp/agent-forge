import { createHash, createHmac, type BinaryLike, type Hash, type Hmac } from "node:crypto";

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

import {
  bedrockToolSpecs,
  readModelResponse,
  type AskConverse,
  type AskModelMessage,
  type AskModelTurn,
} from "@/lib/ask-tenant/compose";

const DEFAULT_MODEL_ID = "us.amazon.nova-lite-v1:0";

export function askTenantModelId(): string | null {
  const configured = process.env.ASK_TENANT_MODEL_ID?.trim();
  if (!configured) {
    return null;
  }
  return configured === "default" ? DEFAULT_MODEL_ID : configured;
}

export function bedrockConverseFromEnv(): AskConverse | null {
  const modelId = askTenantModelId();
  if (!modelId) {
    return null;
  }
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  return (turn) => converseOnce(region, modelId, turn);
}

async function converseOnce(region: string, modelId: string, turn: AskModelTurn): Promise<ReturnType<typeof readModelResponse>> {
  const credentials = await defaultProvider()();
  const body = JSON.stringify({
    system: [{ text: turn.system }],
    messages: turn.messages.map(toBedrockMessage),
    ...(turn.toolsEnabled ? { toolConfig: { tools: bedrockToolSpecs().map(toToolSpec) } } : {}),
    inferenceConfig: { maxTokens: 700, temperature: 0.2 },
  });
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const endpoint = new URL(url);
  const signer = new SignatureV4({
    credentials,
    region,
    service: "bedrock",
    sha256: NodeSha256,
  });
  const signed = await signer.sign({
    method: "POST",
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    path: `${endpoint.pathname}${endpoint.search}`,
    headers: { "content-type": "application/json" },
    body,
  });
  const headers = Object.fromEntries(
    Object.entries(signed.headers).flatMap(([key, value]) =>
      typeof value === "string" ? [[key, value]] : [],
    ),
  );
  const response = await fetch(url, { method: "POST", headers, body });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Bedrock request failed (${response.status}): ${detail.slice(0, 240)}`);
  }
  const payload = (await response.json()) as { output?: { message?: { content?: unknown } } };
  return readModelResponse(payload.output?.message?.content);
}

function toBedrockMessage(message: AskModelMessage) {
  if (message.role === "tool") {
    return {
      role: "user",
      content: message.results.map((result) => ({
        toolResult: {
          toolUseId: result.id,
          content: [{ text: result.text }],
          status: result.error ? "error" : "success",
        },
      })),
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: [
        ...(message.text ? [{ text: message.text }] : []),
        ...message.tools.map((tool) => ({
          toolUse: {
            toolUseId: tool.id,
            name: tool.name,
            input: { query: tool.query },
          },
        })),
      ],
    };
  }
  return { role: "user", content: [{ text: message.text }] };
}

function toToolSpec(tool: ReturnType<typeof bedrockToolSpecs>[number]) {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema },
    },
  };
}

class NodeSha256 {
  private readonly secret?: unknown;
  private hash: Hash | Hmac;

  constructor(secret?: unknown) {
    this.secret = secret;
    this.hash = secret ? createHmac("sha256", secret as BinaryLike) : createHash("sha256");
  }

  update(data: Uint8Array | string): void {
    this.hash.update(data);
  }

  async digest(): Promise<Uint8Array> {
    return this.hash.digest();
  }

  reset(): void {
    this.hash = this.secret ? createHmac("sha256", this.secret as BinaryLike) : createHash("sha256");
  }
}
