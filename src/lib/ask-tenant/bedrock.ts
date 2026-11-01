import { createHash, createHmac } from "node:crypto";

import { defaultProvider } from "@aws-sdk/credential-provider-node";

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

export function signAwsRequest(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  amzDate: string;
  contentSha256?: boolean;
}): Record<string, string> {
  const url = new URL(input.url);
  const payloadHash = sha256(input.body);
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(input.headers)) {
    headers.set(key.toLowerCase(), value.trim());
  }
  headers.set("host", url.host);
  headers.set("x-amz-date", input.amzDate);
  if (input.contentSha256) {
    headers.set("x-amz-content-sha256", payloadHash);
  }
  if (input.sessionToken) {
    headers.set("x-amz-security-token", input.sessionToken);
  }
  const signedHeaderNames = [...headers.keys()].sort();
  const canonicalHeaders = signedHeaderNames.map((key) => `${key}:${headers.get(key)}\n`).join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const dateStamp = input.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secretAccessKey, dateStamp, input.region, input.service))
    .update(stringToSign)
    .digest("hex");
  const signed = Object.fromEntries(headers);
  signed.authorization = [
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaderNames.join(";")}`,
    `Signature=${signature}`,
  ].join(", ");
  return signed;
}

async function converseOnce(region: string, modelId: string, turn: AskModelTurn): Promise<ReturnType<typeof readModelResponse>> {
  const credentials = await defaultProvider()();
  const body = JSON.stringify({
    system: [{ text: turn.system }],
    messages: turn.messages.map(toBedrockMessage),
    ...(turn.toolsEnabled ? { toolConfig: { tools: bedrockToolSpecs().map(toToolSpec) } } : {}),
    inferenceConfig: { maxTokens: 700, temperature: 0.2 },
  });
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  const headers = signAwsRequest({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    body,
    region,
    service: "bedrock",
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    amzDate,
    contentSha256: true,
  });
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

function canonicalUri(pathname: string): string {
  const decoded = pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return decoded.map((segment) => encodeURIComponent(segment)).join("/") || "/";
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
