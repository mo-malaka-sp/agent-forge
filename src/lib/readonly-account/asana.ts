import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import {
  activateTestAccount,
  asanaAccountLocation,
  openRequestedAccount,
  readonlyAccountClient,
  type TenantRefs,
  type TestUser,
} from "@/lib/readonly-account/tenant";

type SailClient = ReturnType<typeof readonlyAccountClient>;

const ASANA_API = "https://app.asana.com/api/1.0";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const TASK_GID = /^[0-9]{5,20}$/;

export type AsanaAccountJob = {
  asanaTaskGid: string;
  user: TestUser;
  refs: TenantRefs;
  sailPointTaskId: string | null;
  processed: boolean;
  inviteSent: boolean;
  inviteError: string | null;
  attempt: number;
  commented: boolean;
  detail: string;
  createdAt: string;
};

export type AsanaAccountStatus = {
  accepted: boolean;
  asanaTaskGid: string;
  userId: string;
  email: string;
  done: boolean;
  detail: string;
};

type AsanaTask = {
  name?: string;
  notes?: string;
  assignee?: { email?: string } | null;
  custom_fields?: Array<{
    name?: string;
    display_value?: string | null;
    text_value?: string | null;
  }>;
};

type JobStore = {
  load(): AsanaAccountJob[];
  save(jobs: AsanaAccountJob[]): void;
};

export function asanaTaskGid(value: string): string {
  const gid = value.trim();
  if (!TASK_GID.test(gid)) {
    throw new Error("Asana task id is missing or invalid.");
  }
  return gid;
}

export function personFromAsanaTask(task: AsanaTask): {
  givenName: string;
  familyName: string;
  email: string;
} {
  const email = emailFromTask(task);
  if (!email) {
    throw new Error("The Asana task needs an email address.");
  }
  const name = nameFromTask(task);
  const parts = nameParts(name);
  if (!parts) {
    throw new Error("The Asana task name needs a first and last name.");
  }
  return { ...parts, email };
}

export function fileJobStore(filePath = defaultJobPath()): JobStore {
  return {
    load() {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { jobs?: AsanaAccountJob[] };
      return Array.isArray(parsed.jobs) ? parsed.jobs : [];
    },
    save(jobs) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ jobs }, null, 2));
    },
  };
}

export async function acceptAsanaTask(
  taskGid: string,
  options: {
    token?: string;
    fetchImpl?: typeof fetch;
    store?: JobStore;
    random?: () => number;
    client?: SailClient;
  } = {},
): Promise<AsanaAccountStatus> {
  const gid = asanaTaskGid(taskGid);
  const store = options.store ?? fileJobStore();
  const client = options.client ?? readonlyAccountClient();
  const jobs = store.load();
  const existing = jobs.find((job) => job.asanaTaskGid === gid);
  if (existing) {
    return statusOf(
      await advanceJob(existing, store, jobs, {
        token: options.token,
        fetchImpl: options.fetchImpl,
        client,
      }),
    );
  }
  const task = await fetchAsanaTask(gid, options.token, options.fetchImpl);
  const person = personFromAsanaTask(task);
  const opened = await openRequestedAccount(
    client,
    {
      ...person,
      location: asanaAccountLocation(gid),
    },
    options.random,
  );
  const job: AsanaAccountJob = {
    asanaTaskGid: gid,
    user: opened.result.user,
    refs: opened.result.refs,
    sailPointTaskId: opened.result.taskId,
    processed: false,
    inviteSent: false,
    inviteError: null,
    attempt: 0,
    commented: false,
    detail: opened.created ? "Account requested." : "Account already exists for this Asana task.",
    createdAt: new Date().toISOString(),
  };
  jobs.push(job);
  store.save(jobs);
  return statusOf(
    await advanceJob(job, store, jobs, {
      token: options.token,
      fetchImpl: options.fetchImpl,
      client,
    }),
  );
}

export async function tickAsanaAccounts(
  options: {
    token?: string;
    fetchImpl?: typeof fetch;
    store?: JobStore;
    client?: SailClient;
  } = {},
): Promise<AsanaAccountStatus[]> {
  const store = options.store ?? fileJobStore();
  const client = options.client ?? readonlyAccountClient();
  const jobs = store.load();
  const pending = jobs.filter((job) => !job.commented).slice(0, 5);
  const statuses: AsanaAccountStatus[] = [];
  for (const job of pending) {
    try {
      statuses.push(
        statusOf(
          await advanceJob(job, store, jobs, {
            token: options.token,
            fetchImpl: options.fetchImpl,
            client,
          }),
        ),
      );
    } catch (error) {
      job.detail = error instanceof Error ? error.message : "Account activation failed.";
      store.save(jobs);
      statuses.push(statusOf(job));
    }
  }
  return statuses;
}

async function advanceJob(
  job: AsanaAccountJob,
  store: JobStore,
  jobs: AsanaAccountJob[],
  options: { token?: string; fetchImpl?: typeof fetch; client: SailClient },
): Promise<AsanaAccountJob> {
  if (!job.commented) {
    const result = await activateTestAccount(options.client, {
      ...job.refs,
      userId: job.user.id,
      taskId: job.sailPointTaskId,
      attempt: job.attempt,
      processed: job.processed,
      sendInvite: true,
      inviteEmail: job.user.email,
      inviteSent: job.inviteSent,
      inviteError: job.inviteError,
    });
    job.attempt += 1;
    job.processed = result.processed;
    job.inviteSent = result.inviteSent;
    job.inviteError = result.inviteError;
    job.detail = result.detail;
    store.save(jobs);
    if (result.done) {
      await commentOnAsanaTask(job, options.token, options.fetchImpl);
      job.commented = true;
      store.save(jobs);
    }
  }
  return job;
}

function statusOf(job: AsanaAccountJob): AsanaAccountStatus {
  return {
    accepted: true,
    asanaTaskGid: job.asanaTaskGid,
    userId: job.user.id,
    email: job.user.email,
    done: job.commented,
    detail: job.detail,
  };
}

async function fetchAsanaTask(
  taskGid: string,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<AsanaTask> {
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const fields = "name,notes,assignee.email,custom_fields.name,custom_fields.display_value,custom_fields.text_value";
  const response = await fetchImpl(
    `${ASANA_API}/tasks/${taskGid}?opt_fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Asana did not return the task (${response.status}).`);
  }
  const body = (await response.json()) as { data?: AsanaTask };
  return body.data ?? {};
}

export async function commentAsanaOnce(
  taskGid: string,
  text: string,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const listed = await fetchImpl(
    `${ASANA_API}/tasks/${taskGid}/stories?opt_fields=text&limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (listed.ok) {
    const body = (await listed.json()) as { data?: Array<{ text?: string }> };
    if ((body.data ?? []).some((story) => story.text === text)) {
      return;
    }
  }
  const response = await fetchImpl(`${ASANA_API}/tasks/${taskGid}/stories`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { text } }),
  });
  if (!response.ok) {
    throw new Error(`Asana did not save the account comment (${response.status}).`);
  }
}

async function commentOnAsanaTask(
  job: AsanaAccountJob,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const text = [
    "SAF Test Drive account",
    `Username: ${job.user.id}`,
    `Email: ${job.user.email}`,
    job.detail,
  ].join("\n");
  await commentAsanaOnce(job.asanaTaskGid, text, token, fetchImpl);
}

function emailFromTask(task: AsanaTask): string {
  for (const field of task.custom_fields ?? []) {
    if (!/e-?mail/i.test(field.name ?? "")) {
      continue;
    }
    const value = (field.display_value || field.text_value || "").trim();
    if (EMAIL.test(value)) {
      return value;
    }
  }
  const noted = task.notes?.match(EMAIL_IN_TEXT)?.[0];
  if (noted) {
    return noted;
  }
  const assignee = task.assignee?.email?.trim() ?? "";
  return EMAIL.test(assignee) ? assignee : "";
}

function nameFromTask(task: AsanaTask): string {
  for (const field of task.custom_fields ?? []) {
    if (!/^(name|requester|full name)$/i.test(field.name ?? "")) {
      continue;
    }
    const value = (field.display_value || field.text_value || "").trim();
    if (value) {
      return value;
    }
  }
  return task.name?.trim() ?? "";
}

function nameParts(value: string): { givenName: string; familyName: string } | null {
  const words = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1);
  if (words.length < 2) {
    return null;
  }
  return { givenName: words[0], familyName: words[1] };
}

function defaultJobPath(): string {
  return path.join(resolveAgentForgeDataDir(), "readonly-account-asana.json");
}
