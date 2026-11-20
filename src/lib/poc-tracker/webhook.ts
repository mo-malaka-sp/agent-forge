import { taskGidsForSlackSync } from "@/lib/readonly-account/asana-slack-sync";
import {
  asanaSignatureMatches,
  type WebhookReceipt,
  type WebhookStore,
} from "@/lib/readonly-account/asana-webhook";

const STASH_PENDING = "pending";

export type PocTrackerReceipt = WebhookReceipt & {
  taskGids: string[];
};

export async function receivePocTrackerWebhook(
  input: {
    hookSecret: string | null;
    signature: string | null;
    body: string;
    stashGid?: string;
  },
  options: {
    store: WebhookStore;
    readSecret?: (stashGid: string) => Promise<string>;
    writeSecret?: (stashGid: string, secret: string) => Promise<void>;
    record?: (message: string) => Promise<void>;
  },
): Promise<PocTrackerReceipt> {
  const stashGid = input.stashGid?.trim() ?? "";
  if (input.hookSecret) {
    if (!stashGid || !options.writeSecret) {
      return { status: 500, headers: {}, body: { error: "Webhook handshake could not be stored." }, taskGids: [] };
    }
    await options.writeSecret(stashGid, input.hookSecret);
    await options.store.update({ secret: input.hookSecret });
    await options.record?.("Handshake completed.");
    return { status: 200, headers: { "X-Hook-Secret": input.hookSecret }, body: null, taskGids: [] };
  }

  const state = await options.store.load();
  let secret = state?.secret ?? "";
  if (!asanaSignatureMatches(input.body, secret, input.signature) && stashGid && options.readSecret) {
    secret = await options.readSecret(stashGid);
    if (secret && secret !== STASH_PENDING) {
      await options.store.update({ secret });
    }
  }
  if (!secret || !asanaSignatureMatches(input.body, secret, input.signature)) {
    await options.record?.("Delivery rejected. The signature did not match.");
    return { status: 401, headers: {}, body: { error: "Webhook signature was rejected." }, taskGids: [] };
  }

  let payload: { events?: unknown };
  try {
    payload = input.body ? (JSON.parse(input.body) as { events?: unknown }) : {};
  } catch {
    return { status: 400, headers: {}, body: { error: "Webhook body must be valid JSON." }, taskGids: [] };
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  if (events.length === 0) {
    await options.record?.("Heartbeat received.");
    return { status: 200, headers: {}, body: { ok: true, accepted: [] }, taskGids: [] };
  }

  const taskGids = taskGidsForSlackSync(events);
  await options.record?.(
    taskGids.length > 0
      ? `Delivery received ${events.length} event(s) for ${taskGids.join(", ")}.`
      : `Delivery received ${events.length} event(s). None of them named a task.`,
  );
  return { status: 200, headers: {}, body: { ok: true, accepted: taskGids }, taskGids };
}
