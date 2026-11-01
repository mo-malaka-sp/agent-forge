type Detail = { label: string; value: string };

const PURPOSE_LABEL = /description|comment|instruction/i;
const SKIP_LABEL =
  /^(manually created|name|created|schema name|identity|native identity|profile|subtype)$/i;

export function narrateAgent(row: Record<string, unknown>): string {
  const name = text(row.name) ?? "This agent";
  const risk = (text(row.riskLevel) || "Unknown").toLowerCase();
  const source = text(row.source);
  const owner = text(row.owner);
  const details = detailsOf(row);
  const kind = agentKind(details);
  const sentences = [
    opening(name, risk, kind, source, owner),
    stateSentence(details),
    purposeSentence(details),
    runtimeSentence(details),
    accessSentence(details),
    findingsSentence(row),
  ].filter(Boolean);
  return sentences.join(" ");
}

function opening(
  name: string,
  risk: string,
  kind: string,
  source: string | undefined,
  owner: string | undefined,
): string {
  const who = `${name} is a ${risk}-risk${kind ? ` ${kind}` : ""} agent`;
  const where = source ? ` on ${source}` : "";
  const whose = owner ? `, owned by ${owner}` : "";
  return `${who}${where}${whose}.`;
}

function agentKind(details: Detail[]): string {
  const agentType = value(details, /^agent type$/i);
  if (agentType && !/^ai agent$/i.test(agentType)) {
    return agentType.toLowerCase();
  }
  return "";
}

function stateSentence(details: Detail[]): string {
  const status = value(details, /^status$/i)?.toLowerCase();
  const sanctioned = value(details, /sanction/i)?.toLowerCase();
  if (status && sanctioned) {
    return `It is ${status} and ${sanctioned}.`;
  }
  if (status) {
    return `It is ${status}.`;
  }
  if (sanctioned) {
    return `It is ${sanctioned}.`;
  }
  return "";
}

function purposeSentence(details: Detail[]): string {
  const sentences = uniqueSentences(
    details.filter((detail) => PURPOSE_LABEL.test(detail.label)).map((detail) => readable(detail.value)),
  );
  if (sentences.length === 0) {
    return "SailPoint stores no description of what it does.";
  }
  return sentences.slice(0, 4).join(" ");
}

function runtimeSentence(details: Detail[]): string {
  const model = value(details, /^model$/i);
  const database = value(details, /database/i);
  const application = businessApplication(details);
  const tools = value(details, /^tools$/i);
  const parts = [
    model ? `model ${model}` : "",
    database ? `database ${database}` : "",
    application ? application : "",
    tools ? `tools ${tools}` : "",
  ].filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `It runs with ${joinList(parts)}.`;
}

function accessSentence(details: Detail[]): string {
  const roles = splitList(value(details, /^roles$/i));
  const entitlements = splitList(value(details, /entitlement/i)).filter(
    (item) => !roles.some((role) => role.toLowerCase() === item.toLowerCase()),
  );
  const parts = [
    roles.length > 0 ? `roles ${joinList(roles)}` : "",
    entitlements.length > 0 ? `entitlements ${joinList(entitlements)}` : "",
  ].filter(Boolean);
  if (parts.length === 0) {
    return "";
  }
  return `Its access is ${joinList(parts)}.`;
}

function findingsSentence(row: Record<string, unknown>): string {
  const findings = Array.isArray(row.findings) ? row.findings.filter((item) => typeof item === "string") : [];
  if (findings.length > 0) {
    return `SailPoint findings: ${findings.join("; ")}.`;
  }
  const note = text(row.findingsNote);
  if (note && /no findings/i.test(note)) {
    return "SailPoint returned no findings for this agent.";
  }
  return note ? `${note}.` : "SailPoint returned no findings for this agent.";
}

function businessApplication(details: Detail[]): string {
  const labeled = details.filter((detail) => /business application/i.test(detail.label));
  const readableValue = labeled
    .map((detail) => detail.value.trim())
    .find((item) => item.includes(" ") || /[A-Z]/.test(item.slice(1)));
  return readableValue ?? labeled[0]?.value ?? "";
}

function value(details: Detail[], label: RegExp): string | undefined {
  const found = details.find((detail) => label.test(detail.label) && !SKIP_LABEL.test(detail.label));
  const shown = found ? readable(found.value) : "";
  return shown || undefined;
}

function detailsOf(row: Record<string, unknown>): Detail[] {
  if (!Array.isArray(row.details)) {
    return [];
  }
  return row.details.flatMap((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const label = text(record?.label);
    const fieldValue = text(record?.value);
    return label && fieldValue ? [{ label, value: fieldValue }] : [];
  });
}

function readable(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed;
  }
  try {
    return proseFromJson(JSON.parse(trimmed)) || trimmed;
  } catch {
    const quoted = [...trimmed.matchAll(/"((?:[^"\\]|\\.){20,})"/g)].map((match) =>
      match[1].replace(/\\"/g, '"').trim(),
    );
    return quoted.join(" ") || trimmed;
  }
}

function proseFromJson(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(proseFromJson).filter(Boolean).join(" ");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  return Object.values(value as Record<string, unknown>)
    .map(proseFromJson)
    .filter((item) => item.length > 20)
    .join(" ");
}

function uniqueSentences(chunks: string[]): string[] {
  const sentences = chunks
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12 && !/^you are\b/i.test(sentence));
  const kept: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    if (kept.some((item) => item.toLowerCase().includes(key) || key.includes(item.toLowerCase()))) {
      continue;
    }
    kept.push(sentence.endsWith(".") || sentence.endsWith("!") || sentence.endsWith("?") ? sentence : `${sentence}.`);
  }
  return kept;
}

function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
