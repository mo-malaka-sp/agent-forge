import { randomUUID, timingSafeEqual } from "node:crypto";

import { loadSafPocConfig } from "@/lib/saf-poc/config";
import { createSigningKey, signSet, type SigningKey } from "@/lib/saf-poc/jwt";
import { getSafPocStore } from "@/lib/saf-poc/storage";

export const RISK_LEVEL_CHANGE_EVENT =
  "https://schemas.openid.net/secevent/caep/event-type/risk-level-change";
export const VERIFICATION_EVENT =
  "https://schemas.openid.net/secevent/ssf/event-type/verification";

const STATE_KEY = "SSF#state";
const PUSH_METHODS = new Set([
  "urn:ietf:rfc:8935",
  "https://schemas.openid.net/secevent/risc/delivery-method/push",
]);
const POLL_METHODS = new Set([
  "urn:ietf:rfc:8936",
  "https://schemas.openid.net/secevent/risc/delivery-method/poll",
]);
const RISK_LEVELS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const STREAM_STATUSES = new Set(["enabled", "paused", "disabled"]);

type StreamStatus = "enabled" | "paused" | "disabled";
type DeliveryKind = "push" | "poll";

type StreamRecord = {
  streamId: string;
  aud: string[];
  description: string;
  method: string;
  endpointUrl: string;
  eventsRequested: string[];
  eventsDelivered: string[];
  status: StreamStatus;
  subjects: string[];
};

type PendingEvent = {
  jti: string;
  streamId: string;
  email: string;
  previousLevel: string;
  currentLevel: string;
  kind: "risk" | "verification";
  state: string;
};

type PersistedTransmitter = {
  kid: string;
  privateKeyPem: string;
  publicJwk: Record<string, string>;
  apiToken: string;
  stream: StreamRecord | null;
  pending: PendingEvent[];
};

export type DeliveryReport = {
  jti: string;
  streamId: string;
  method: DeliveryKind | "held";
  status: number | null;
  accepted: boolean;
  detail: string;
};

export type SsfResult = {
  status: number;
  body?: unknown;
  empty?: boolean;
};

type Runtime = {
  key: SigningKey;
  apiToken: string;
  stream: StreamRecord | null;
  pending: PendingEvent[];
};

class TransmitterRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransmitterRequestError";
  }
}

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function transmitterIssuer(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.origin;
}

export function configurationDocument(publicUrl: string): Record<string, unknown> {
  const issuer = transmitterIssuer(publicUrl);
  return {
    spec_version: "1_0-ID2",
    issuer,
    jwks_uri: `${issuer}/jwks`,
    delivery_methods_supported: [...PUSH_METHODS, ...POLL_METHODS],
    configuration_endpoint: `${issuer}/ssf/stream`,
    status_endpoint: `${issuer}/ssf/status`,
    add_subject_endpoint: `${issuer}/ssf/subjects/add`,
    remove_subject_endpoint: `${issuer}/ssf/subjects/remove`,
    verification_endpoint: `${issuer}/ssf/verify`,
    events_supported: [RISK_LEVEL_CHANGE_EVENT, VERIFICATION_EVENT],
    critical_subject_members: ["user"],
    authorization_schemes: [{ spec_urn: "urn:ietf:rfc:6749" }],
  };
}

export async function readTransmitterPublicKey(): Promise<Record<string, string>> {
  const runtime = await loadRuntime();
  return runtime.key.publicJwk;
}

export async function readApiToken(): Promise<string> {
  const runtime = await loadRuntime();
  return runtime.apiToken;
}

export async function readTransmitterSummary(publicUrl: string) {
  const runtime = await loadRuntime();
  const issuer = transmitterIssuer(publicUrl);
  return {
    issuer,
    discoveryUrl: `${issuer}/.well-known/ssf-configuration`,
    jwksUrl: `${issuer}/jwks`,
    streamEndpoint: `${issuer}/ssf/stream`,
    https: issuer.startsWith("https://"),
    streamRegistered: Boolean(runtime.stream),
    streamStatus: runtime.stream?.status ?? null,
    deliveryMethod: runtime.stream?.method ?? null,
    subjects: runtime.stream?.subjects ?? [],
    tokenConfigured: Boolean(runtime.apiToken),
  };
}

export async function publishRiskLevelChange(input: {
  publicUrl: string;
  email: string;
  previousLevel: string;
  currentLevel: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  email: string;
  previousLevel: string;
  currentLevel: string;
  deliveries: DeliveryReport[];
}> {
  return enqueue(async () => {
    const runtime = await loadRuntime();
    const email = input.email.trim().toLowerCase();
    const previousLevel = levelOrDefault(input.previousLevel, "LOW");
    const currentLevel = levelOrDefault(input.currentLevel, "HIGH");
    if (!email) {
      throw new TransmitterRequestError("A correlated identity email is required.");
    }
    if (!previousLevel || !currentLevel) {
      throw new TransmitterRequestError(
        "Risk levels must be LOW, MEDIUM, HIGH, or CRITICAL.",
      );
    }
    const delivery = await deliverEvent(
      runtime,
      transmitterIssuer(input.publicUrl),
      pendingRisk(email, previousLevel, currentLevel),
      input.fetchImpl,
    );
    return {
      email,
      previousLevel,
      currentLevel,
      deliveries: [delivery],
    };
  });
}

export async function dispatchSsf(input: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  authorization?: string;
  publicUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<SsfResult> {
  return enqueue(() => dispatchUnlocked(input));
}

async function dispatchUnlocked(input: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  authorization?: string;
  publicUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<SsfResult> {
  const runtime = await loadRuntime();
  if (!tokensMatch(runtime.apiToken, presentedToken(input.authorization ?? ""))) {
    return { status: 401, body: { error: "invalid_token" } };
  }

  const issuer = transmitterIssuer(input.publicUrl);
  const method = input.method.toUpperCase();
  const path = input.path.replace(/^\/+/, "");
  const query = input.query ?? {};
  const body = asRecord(input.body);

  try {
    if (path === "stream" && method === "POST") {
      const created = runtime.stream === null;
      runtime.stream = streamFromRequest(issuer, body, runtime.stream);
      await flushPush(runtime, issuer, input.fetchImpl);
      await saveRuntime(runtime);
      return {
        status: created ? 201 : 200,
        body: publicStream(issuer, runtime.stream),
      };
    }

    if (path === "stream" && method === "GET") {
      const resolved = resolveStream(runtime.stream, query.stream_id ?? "");
      if (resolved === "missing") {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      if (Array.isArray(resolved)) {
        return { status: 200, body: resolved.map((item) => publicStream(issuer, item)) };
      }
      return { status: 200, body: publicStream(issuer, resolved) };
    }

    if (path === "stream" && (method === "PUT" || method === "PATCH")) {
      if (!runtime.stream) {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      const streamId =
        typeof body.stream_id === "string" ? body.stream_id : query.stream_id ?? "";
      if (streamId && streamId !== runtime.stream.streamId) {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      runtime.stream = streamFromRequest(
        issuer,
        body,
        runtime.stream,
        runtime.stream.streamId,
      );
      await flushPush(runtime, issuer, input.fetchImpl);
      await saveRuntime(runtime);
      return { status: 200, body: publicStream(issuer, runtime.stream) };
    }

    if (path === "stream" && method === "DELETE") {
      const streamId = query.stream_id ?? "";
      if (!runtime.stream || (streamId && runtime.stream.streamId !== streamId)) {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      runtime.stream = null;
      runtime.pending = [];
      await saveRuntime(runtime);
      return { status: 204, empty: true };
    }

    if (path === "status" && method === "GET") {
      const stream = requireOne(resolveStream(runtime.stream, query.stream_id ?? ""));
      if (stream === "missing") {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      return { status: 200, body: { stream_id: stream.streamId, status: stream.status } };
    }

    if (path === "status" && method === "POST") {
      const status = typeof body.status === "string" ? body.status : "";
      if (!STREAM_STATUSES.has(status)) {
        return { status: 400, body: { error: "status must be enabled, paused, or disabled." } };
      }
      const stream = requireOne(
        resolveStream(
          runtime.stream,
          typeof body.stream_id === "string" ? body.stream_id : "",
        ),
      );
      if (stream === "missing") {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      stream.status = status as StreamStatus;
      if (stream.status === "enabled") {
        await flushPush(runtime, issuer, input.fetchImpl);
      }
      await saveRuntime(runtime);
      return { status: 200, body: { stream_id: stream.streamId, status: stream.status } };
    }

    if (path === "subjects/add" || path === "subjects/remove") {
      const email = emailFromSubject(body);
      const stream = requireOne(
        resolveStream(
          runtime.stream,
          typeof body.stream_id === "string" ? body.stream_id : "",
        ),
      );
      if (!email) {
        return { status: 400, body: { error: "subject email is required." } };
      }
      if (stream === "missing") {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      if (path.endsWith("/remove")) {
        stream.subjects = stream.subjects.filter((subject) => subject !== email);
      } else if (!stream.subjects.includes(email)) {
        stream.subjects.push(email);
      }
      await saveRuntime(runtime);
      return {
        status: 200,
        body: { stream_id: stream.streamId, subject: { format: "email", email } },
      };
    }

    if (path === "verify" && method === "POST") {
      const stream = requireOne(
        resolveStream(
          runtime.stream,
          typeof body.stream_id === "string" ? body.stream_id : "",
        ),
      );
      if (stream === "missing") {
        return { status: 404, body: { error: "stream_not_found" } };
      }
      const state = typeof body.state === "string" ? body.state : "";
      await deliverEvent(
        runtime,
        issuer,
        pendingVerification(state),
        input.fetchImpl,
      );
      return { status: 204, empty: true };
    }

    if (path === "poll" && method === "POST") {
      const ack = stringList(body.ack);
      if (ack.length > 0) {
        runtime.pending = runtime.pending.filter((event) => !ack.includes(event.jti));
      }
      const stream = runtime.stream;
      if (!stream || deliveryKind(stream.method) !== "poll" || stream.status !== "enabled") {
        await saveRuntime(runtime);
        return { status: 200, body: { sets: {}, moreAvailable: false } };
      }
      const maxEvents = positiveInteger(body.maxEvents, 10);
      const matching = runtime.pending.filter(
        (event) =>
          (event.streamId === "" || event.streamId === stream.streamId) &&
          (event.kind === "verification" || allows(stream, event.email)),
      );
      const batch = matching.slice(0, maxEvents);
      const sets: Record<string, string> = {};
      for (const event of batch) {
        event.streamId = stream.streamId;
        sets[event.jti] = signEvent(runtime, issuer, stream, event);
      }
      await saveRuntime(runtime);
      return {
        status: 200,
        body: { sets, moreAvailable: matching.length > batch.length },
      };
    }

    if (path === "risk-level-change" && method === "POST") {
      const email = (
        (typeof body.email === "string" && body.email.trim()) ||
        loadSafPocConfig().notifyEmail
      ).toLowerCase();
      const previousLevel = levelOrDefault(body.previousLevel, "LOW");
      const currentLevel = levelOrDefault(body.currentLevel, "HIGH");
      if (!email) {
        return { status: 400, body: { error: "Set SAF_NOTIFY_EMAIL or pass an email." } };
      }
      if (!previousLevel || !currentLevel) {
        return {
          status: 400,
          body: { error: "Risk levels must be LOW, MEDIUM, HIGH, or CRITICAL." },
        };
      }
      const delivery = await deliverEvent(
        runtime,
        issuer,
        pendingRisk(email, previousLevel, currentLevel),
        input.fetchImpl,
      );
      return {
        status: 202,
        body: { email, previousLevel, currentLevel, deliveries: [delivery] },
      };
    }

    return { status: 404, body: { error: "Unknown transmitter route." } };
  } catch (error) {
    if (error instanceof TransmitterRequestError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }
}

async function loadRuntime(): Promise<Runtime> {
  const config = loadSafPocConfig();
  const existing = await getSafPocStore().get<PersistedTransmitter>(STATE_KEY);
  const generated = existing?.privateKeyPem ? null : createSigningKey();
  const runtime: Runtime = {
    key: generated ?? {
      kid: existing?.kid ?? "",
      privateKeyPem: existing?.privateKeyPem ?? "",
      publicJwk: existing?.publicJwk ?? {},
    },
    apiToken: config.ssfApiToken || existing?.apiToken || randomUUID().replaceAll("-", ""),
    stream: existing?.stream ?? null,
    pending: Array.isArray(existing?.pending) ? existing.pending : [],
  };
  if (
    !existing ||
    existing.apiToken !== runtime.apiToken ||
    existing.kid !== runtime.key.kid
  ) {
    await saveRuntime(runtime);
  }
  return runtime;
}

async function saveRuntime(runtime: Runtime): Promise<void> {
  const persisted: PersistedTransmitter = {
    kid: runtime.key.kid,
    privateKeyPem: runtime.key.privateKeyPem,
    publicJwk: runtime.key.publicJwk,
    apiToken: runtime.apiToken,
    stream: runtime.stream,
    pending: runtime.pending,
  };
  await getSafPocStore().put(STATE_KEY, persisted);
}

function signEvent(
  runtime: Runtime,
  issuer: string,
  stream: StreamRecord,
  event: PendingEvent,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload =
    event.kind === "verification"
      ? verificationPayload(issuer, event.jti, stream.aud, event.state, now)
      : riskPayload(issuer, event, stream.aud, now);
  return signSet(runtime.key, payload);
}

async function pushSet(
  endpointUrl: string,
  set: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/secevent+jwt",
      Accept: "application/json",
    },
    body: set,
    signal: AbortSignal.timeout(15_000),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: (await response.text()).slice(0, 500),
  };
}

async function flushPush(
  runtime: Runtime,
  issuer: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const stream = runtime.stream;
  if (!stream || stream.status !== "enabled" || deliveryKind(stream.method) !== "push") {
    return;
  }
  const queued = runtime.pending.filter(
    (event) => event.streamId === "" || event.streamId === stream.streamId,
  );
  for (const event of queued) {
    if (event.kind === "risk" && !allows(stream, event.email)) {
      continue;
    }
    event.streamId = stream.streamId;
    const result = await pushSet(stream.endpointUrl, signEvent(runtime, issuer, stream, event), fetchImpl);
    if (result.ok) {
      runtime.pending = runtime.pending.filter((item) => item.jti !== event.jti);
    }
  }
}

async function deliverEvent(
  runtime: Runtime,
  issuer: string,
  event: PendingEvent,
  fetchImpl?: typeof fetch,
): Promise<DeliveryReport> {
  const stream = runtime.stream;
  if (!stream) {
    runtime.pending.push(event);
    await saveRuntime(runtime);
    return report(event, "held", null, true, "Queued until the receiver stream connects.");
  }
  if (event.kind === "risk" && !allows(stream, event.email)) {
    return report(event, "held", null, false, "The receiver stream is not subscribed to this email.");
  }
  event.streamId = stream.streamId;
  runtime.pending.push(event);
  if (stream.status !== "enabled") {
    await saveRuntime(runtime);
    return report(event, "held", null, true, `Queued while the stream is ${stream.status}.`);
  }
  if (deliveryKind(stream.method) === "poll") {
    await saveRuntime(runtime);
    return report(event, "poll", null, true, "Waiting for SailPoint to poll.");
  }
  const result = await pushSet(
    stream.endpointUrl,
    signEvent(runtime, issuer, stream, event),
    fetchImpl,
  );
  if (result.ok) {
    runtime.pending = runtime.pending.filter((item) => item.jti !== event.jti);
  }
  await saveRuntime(runtime);
  return report(
    event,
    "push",
    result.status,
    result.ok,
    result.ok ? "SailPoint accepted the event." : result.body || "SailPoint rejected the event.",
  );
}

function streamFromRequest(
  publicUrl: string,
  body: Record<string, unknown>,
  existing: StreamRecord | null,
  streamId = existing?.streamId ?? randomUUID().replaceAll("-", ""),
): StreamRecord {
  const delivery = asRecord(body.delivery);
  const requestedMethod = typeof delivery.method === "string" ? delivery.method : "";
  const kind = requestedMethod
    ? deliveryKind(requestedMethod)
    : existing
      ? deliveryKind(existing.method)
      : "poll";
  if (!kind) {
    throw new TransmitterRequestError(`Unsupported delivery method: ${requestedMethod}`);
  }
  const method =
    requestedMethod || existing?.method || (kind === "push" ? "urn:ietf:rfc:8935" : "urn:ietf:rfc:8936");
  const requestedEndpoint = typeof delivery.endpoint_url === "string" ? delivery.endpoint_url : "";
  if (kind === "push" && !requestedEndpoint && !existing?.endpointUrl) {
    throw new TransmitterRequestError("Push delivery requires endpoint_url.");
  }
  const endpointUrl =
    kind === "poll" ? `${publicUrl}/ssf/poll` : requestedEndpoint || existing?.endpointUrl || "";
  const eventsRequested =
    body.events_requested === undefined
      ? (existing?.eventsRequested ?? [RISK_LEVEL_CHANGE_EVENT])
      : stringList(body.events_requested);
  const description =
    typeof body.description === "string"
      ? body.description
      : (existing?.description ?? "POC CAEP risk-level transmitter");
  return {
    streamId,
    aud: audience(body.aud, existing?.aud ?? [endpointUrl || publicUrl]),
    description,
    method,
    endpointUrl,
    eventsRequested: eventsRequested.length > 0 ? eventsRequested : [RISK_LEVEL_CHANGE_EVENT],
    eventsDelivered: [RISK_LEVEL_CHANGE_EVENT, VERIFICATION_EVENT],
    status: existing?.status ?? "enabled",
    subjects: existing?.subjects ?? [],
  };
}

function publicStream(publicUrl: string, stream: StreamRecord): Record<string, unknown> {
  return {
    stream_id: stream.streamId,
    iss: publicUrl,
    aud: stream.aud,
    description: stream.description,
    delivery: { method: stream.method, endpoint_url: stream.endpointUrl },
    events_supported: [RISK_LEVEL_CHANGE_EVENT, VERIFICATION_EVENT],
    events_requested: stream.eventsRequested,
    events_delivered: stream.eventsDelivered,
    min_verification_interval: 5,
  };
}

function resolveStream(
  stream: StreamRecord | null,
  streamId: string,
): StreamRecord | StreamRecord[] | "missing" {
  if (!streamId) {
    return stream ? [stream] : [];
  }
  if (!stream || stream.streamId !== streamId) {
    return "missing";
  }
  return stream;
}

function requireOne(
  stream: StreamRecord | StreamRecord[] | "missing",
): StreamRecord | "missing" {
  if (stream === "missing" || Array.isArray(stream)) {
    return Array.isArray(stream) ? (stream[0] ?? "missing") : "missing";
  }
  return stream;
}

function riskPayload(
  issuer: string,
  event: PendingEvent,
  aud: string[],
  now: number,
): Record<string, unknown> {
  return {
    iss: issuer,
    jti: event.jti,
    iat: now,
    aud,
    txn: now,
    sub_id: { format: "email", email: event.email },
    events: {
      [RISK_LEVEL_CHANGE_EVENT]: {
        subject: { format: "email", email: event.email },
        current_level: event.currentLevel,
        previous_level: event.previousLevel,
        event_timestamp: now,
        principal: "USER",
        risk_reason: "PASSWORD_FOUND_IN_DATA_BREACH",
      },
    },
  };
}

function verificationPayload(
  issuer: string,
  jti: string,
  aud: string[],
  state: string,
  now: number,
): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  if (state) {
    event.state = state;
  }
  return { iss: issuer, jti, iat: now, aud, events: { [VERIFICATION_EVENT]: event } };
}

function pendingRisk(email: string, previousLevel: string, currentLevel: string): PendingEvent {
  return {
    jti: randomUUID(),
    streamId: "",
    email,
    previousLevel,
    currentLevel,
    kind: "risk",
    state: "",
  };
}

function pendingVerification(state: string): PendingEvent {
  return {
    jti: randomUUID(),
    streamId: "",
    email: "",
    previousLevel: "",
    currentLevel: "",
    kind: "verification",
    state,
  };
}

function report(
  event: PendingEvent,
  method: DeliveryKind | "held",
  status: number | null,
  accepted: boolean,
  detail: string,
): DeliveryReport {
  return { jti: event.jti, streamId: event.streamId, method, status, accepted, detail };
}

function allows(stream: StreamRecord, email: string): boolean {
  return stream.subjects.length === 0 || stream.subjects.includes(email.toLowerCase());
}

function deliveryKind(method: string): DeliveryKind | null {
  if (PUSH_METHODS.has(method)) {
    return "push";
  }
  if (POLL_METHODS.has(method)) {
    return "poll";
  }
  return null;
}

function audience(value: unknown, fallback: string[]): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  const list = stringList(value);
  return list.length > 0 ? list : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
}

function emailFromSubject(body: Record<string, unknown>): string {
  if (typeof body.email === "string" && body.email.trim()) {
    return body.email.trim().toLowerCase();
  }
  const subject = asRecord(body.subject);
  if (typeof subject.email === "string" && subject.email.trim()) {
    return subject.email.trim().toLowerCase();
  }
  const user = asRecord(subject.user);
  return typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
}

function levelOrDefault(value: unknown, fallback: string): string | null {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return null;
  }
  const level = value.trim().toUpperCase();
  return RISK_LEVELS.has(level) ? level : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function presentedToken(authorization: string): string {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return (bearer?.[1] ?? authorization).trim();
}

function tokensMatch(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
