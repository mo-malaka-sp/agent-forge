import { mcpToolDefinitions } from "@/lib/ask-tenant/mcp";
import {
  answerQuestion,
  isWriteRequest,
  readAsText,
  runAskTool,
  type AskAnswer,
  type AskDeps,
  type AskRead,
  type AskToolName,
} from "@/lib/ask-tenant/tools";

const MAX_ROUNDS = 2;
const MAX_TOOL_CALLS = 4;

const SYSTEM_PROMPT = [
  "You answer questions about one Identity Security Cloud tenant.",
  "Call the provided tools. They are the same read-only tools an MCP client uses.",
  "Use only the tool results. If a tool returns no rows, say so.",
  "Do not invent agents, access, events, or findings.",
  "Do not infer restrictions, permissions, or behavior that the tool results do not state.",
  "Return only the final answer. Never include thinking, analysis, or <thinking> tags.",
  "Do not create, change, or delete data.",
  "When you have the results, answer in a few sentences.",
].join(" ");

export interface AskToolCall {
  id: string;
  name: string;
  query: string;
}

export type AskModelMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: AskToolCall[] }
  | { role: "tool"; results: Array<{ id: string; text: string; error: boolean }> };

export interface AskModelTurn {
  system: string;
  messages: AskModelMessage[];
  toolsEnabled: boolean;
}

export interface AskModelResponse {
  text: string;
  tools: AskToolCall[];
}

export type AskConverse = (turn: AskModelTurn) => Promise<AskModelResponse>;

export function bedrockToolSpecs(): Array<{
  name: AskToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: { query: { type: "string"; description: string } };
    required: ["query"];
  };
}> {
  return mcpToolDefinitions().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: tool.queryDescription },
      },
      required: ["query"],
    },
  }));
}

export function readModelResponse(content: unknown): AskModelResponse {
  if (!Array.isArray(content)) {
    return { text: "", tools: [] };
  }
  const texts: string[] = [];
  const tools: AskToolCall[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    if (typeof record.text === "string" && record.text.trim()) {
      texts.push(record.text.trim());
    }
    const toolUse = asRecord(record.toolUse);
    if (!toolUse || typeof toolUse.name !== "string" || typeof toolUse.toolUseId !== "string") {
      continue;
    }
    tools.push({
      id: toolUse.toolUseId,
      name: toolUse.name,
      query: toolQuery(toolUse.input),
    });
  }
  return { text: texts.join("\n").trim(), tools };
}

export async function answerAskedQuestion(
  question: string,
  deps: AskDeps,
  converse: AskConverse | null,
): Promise<AskAnswer> {
  if (!converse) {
    return { ...(await answerQuestion(question, deps)), answerSource: "keyword" };
  }
  try {
    return { ...(await composeAnswer(question, deps, converse)), answerSource: "model" };
  } catch (error) {
    return {
      ...(await answerQuestion(question, deps)),
      answerSource: "fallback",
      modelError: error instanceof Error ? error.message.slice(0, 240) : "The model call failed.",
    };
  }
}

export async function composeAnswer(
  question: string,
  deps: AskDeps,
  converse: AskConverse,
): Promise<AskAnswer> {
  const trimmed = question.trim();
  if (!trimmed) {
    return {
      tenant: deps.tenant,
      refused: true,
      answer: "Ask a question about this tenant.",
      reads: [],
    };
  }
  if (isWriteRequest(trimmed)) {
    return {
      tenant: deps.tenant,
      refused: true,
      answer: deps.tenant
        ? `Only read-only questions are allowed on tenant ${deps.tenant}.`
        : "Only read-only questions are allowed.",
      reads: [],
    };
  }

  const messages: AskModelMessage[] = [
    {
      role: "user",
      text: deps.tenant ? `Tenant: ${deps.tenant}\n\n${trimmed}` : trimmed,
    },
  ];
  const reads: AskRead[] = [];
  let calls = 0;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await converse({
      system: SYSTEM_PROMPT,
      messages,
      toolsEnabled: calls < MAX_TOOL_CALLS,
    });
    if (response.tools.length === 0) {
      return answered(deps, response.text, reads);
    }
    const batch = response.tools.slice(0, MAX_TOOL_CALLS - calls);
    calls += batch.length;
    const results = [];
    for (const call of batch) {
      const read = await runAskTool(call.name, call.query, deps);
      reads.push(read);
      results.push({
        id: call.id,
        text: readAsText(read),
        error: Boolean(read.error),
      });
    }
    messages.push({ role: "assistant", text: response.text, tools: batch });
    messages.push({ role: "tool", results });
  }

  const finalResponse = await converse({
    system: SYSTEM_PROMPT,
    messages: [
      ...messages,
      {
        role: "user",
        text: "Answer now from the tool results. Do not call tools.",
      },
    ],
    toolsEnabled: false,
  });
  return answered(deps, finalResponse.text, reads);
}

function answered(deps: AskDeps, text: string, reads: AskRead[]): AskAnswer {
  const answer = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  if (!answer) {
    throw new Error("The model returned an empty answer.");
  }
  return {
    tenant: deps.tenant,
    refused: false,
    answer,
    reads,
  };
}

function toolQuery(input: unknown): string {
  if (typeof input === "string") {
    try {
      return toolQuery(JSON.parse(input) as unknown);
    } catch {
      return input.trim() || "*";
    }
  }
  const record = asRecord(input);
  if (record && typeof record.query === "string" && record.query.trim()) {
    return record.query.trim();
  }
  return "*";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
