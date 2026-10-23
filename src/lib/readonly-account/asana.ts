import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import {
  ASSIGNED_SECTION_NAME,
  DEFAULT_ASANA_PROJECT_NAME,
  defaultWebhookStore,
  findProjectGid,
  findSectionGid,
  taskIsInSection,
} from "@/lib/readonly-account/asana-webhook";
import {
  activateTestAccount,
  asanaAccountLocation,
  findAsanaDriveAccounts,
  openLeadSeAccount,
  readonlyAccountClient,
  type TenantRefs,
  type TestUser,
} from "@/lib/readonly-account/tenant";

type SailClient = ReturnType<typeof readonlyAccountClient>;

const ASANA_API = "https://app.asana.com/api/1.0";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TASK_GID = /^[0-9]{5,20}$/;
const LEAD_SE_FIELD = /^lead se$/i;
const TASK_FIELDS = [
  "name",
  "custom_fields.name",
  "custom_fields.type",
  "custom_fields.people_value",
  "custom_fields.people_value.name",
  "custom_fields.people_value.email",
].join(",");

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

type AsanaPerson = {
  gid?: string;
  name?: string;
  email?: string | null;
};

type AsanaTask = {
  name?: string;
  custom_fields?: Array<{
    name?: string;
    type?: string;
    people_value?: AsanaPerson[] | null;
  }>;
};

export type LeadSe = {
  gid: string;
  name: string;
  email: string;
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

export function leadSeFromAsanaTask(task: AsanaTask): LeadSe {
  const field = (task.custom_fields ?? []).find((item) => LEAD_SE_FIELD.test((item.name ?? "").trim()));
  const person = (field?.people_value ?? []).find((value) => value.gid || value.email || value.name);
  if (!person) {
    throw new Error("The task needs a Lead SE.");
  }
  return {
    gid: person.gid?.trim() ?? "",
    name: person.name?.trim() ?? "",
    email: person.email?.trim() ?? "",
  };
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
    projectGid?: string;
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
        projectGid: options.projectGid,
      }),
    );
  }
  const task = await fetchAsanaTask(gid, options.token, options.fetchImpl);
  const leadEmail = await leadSeEmail(leadSeFromAsanaTask(task), options.token, options.fetchImpl);
  const opened = await openLeadSeAccount(
    client,
    {
      leadEmail,
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
      projectGid: options.projectGid,
    }),
  );
}

export async function finishPendingAsanaAccounts(
  options: {
    token?: string;
    fetchImpl?: typeof fetch;
    store?: JobStore;
    client?: SailClient;
    projectGid?: string;
  } = {},
): Promise<AsanaAccountStatus[]> {
  const store = options.store ?? fileJobStore();
  const client = options.client ?? readonlyAccountClient();
  const jobs = store.load();
  const discovered = await findAsanaDriveAccounts(client);
  let changed = false;
  for (const account of discovered) {
    if (jobs.some((job) => job.asanaTaskGid === account.taskGid)) {
      continue;
    }
    const sent = await invitationAlreadySent(account.taskGid, options.token, options.fetchImpl);
    jobs.push({
      asanaTaskGid: account.taskGid,
      user: account.user,
      refs: account.refs,
      sailPointTaskId: null,
      processed: false,
      inviteSent: sent,
      inviteError: null,
      attempt: 0,
      commented: false,
      detail: sent ? "Invitation already sent." : "Account already exists for this Asana task.",
      createdAt: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) {
    store.save(jobs);
  }
  return tickAsanaAccounts({ ...options, store, client });
}

export async function tickAsanaAccounts(
  options: {
    token?: string;
    fetchImpl?: typeof fetch;
    store?: JobStore;
    client?: SailClient;
    projectGid?: string;
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
            projectGid: options.projectGid,
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
  options: { token?: string; fetchImpl?: typeof fetch; client: SailClient; projectGid?: string },
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
    await commentAsanaOnce(
      job.asanaTaskGid,
      ["SAF Test Drive", `Username: ${job.user.id}`, job.detail].join("\n"),
      options.token,
      options.fetchImpl,
    );
    if (result.done && result.inviteSent) {
      try {
        await moveTaskToAssignedSection(job.asanaTaskGid, options);
        job.commented = true;
        store.save(jobs);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The task could not be moved to Assigned.";
        await commentAsanaOnce(
          job.asanaTaskGid,
          `SAF Test Drive\n${message}`,
          options.token,
          options.fetchImpl,
        );
      }
    } else if (result.done) {
      job.commented = true;
      store.save(jobs);
    }
  }
  return job;
}

export async function moveTaskToAssignedSection(
  taskGid: string,
  options: { token?: string; fetchImpl?: typeof fetch; projectGid?: string } = {},
): Promise<void> {
  const token = options.token?.trim() || process.env.ASANA_ACCESS_TOKEN?.trim() || "";
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectGid = await resolveProjectGid(token, fetchImpl, options.projectGid);
  const assignedGid = await findSectionGid(token, projectGid, ASSIGNED_SECTION_NAME, fetchImpl);
  if (await taskIsInSection(token, taskGid, assignedGid, fetchImpl)) {
    return;
  }
  const response = await fetchImpl(`${ASANA_API}/sections/${assignedGid}/addTask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { task: taskGid } }),
  });
  if (!response.ok) {
    throw new Error(`The task could not be moved to Assigned (${response.status}).`);
  }
}

async function resolveProjectGid(
  token: string,
  fetchImpl: typeof fetch,
  projectGid?: string,
): Promise<string> {
  const given = projectGid?.trim() || process.env.ASANA_PROJECT_GID?.trim() || "";
  if (given) {
    return given;
  }
  const stored = (await defaultWebhookStore().load())?.projectGid?.trim() ?? "";
  if (stored) {
    return stored;
  }
  return findProjectGid(token, DEFAULT_ASANA_PROJECT_NAME, fetchImpl);
}

async function leadSeEmail(
  lead: LeadSe,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (EMAIL.test(lead.email)) {
    return lead.email;
  }
  if (!lead.gid) {
    throw new Error("The task needs a Lead SE.");
  }
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const response = await fetchImpl(
    `${ASANA_API}/users/${lead.gid}?opt_fields=${encodeURIComponent("email,name")}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Asana did not return the Lead SE (${response.status}).`);
  }
  const body = (await response.json()) as { data?: { email?: string } };
  const email = body.data?.email?.trim() ?? "";
  if (!EMAIL.test(email)) {
    throw new Error("The task needs a Lead SE.");
  }
  return email;
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

async function invitationAlreadySent(
  taskGid: string,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) {
    return false;
  }
  const response = await fetchImpl(
    `${ASANA_API}/tasks/${taskGid}/stories?opt_fields=text&limit=20`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    return false;
  }
  const body = (await response.json()) as { data?: Array<{ text?: string }> };
  return (body.data ?? []).some((story) => (story.text ?? "").includes("Invitation sent"));
}

async function fetchAsanaTask(
  taskGid: string,
  token = process.env.ASANA_ACCESS_TOKEN?.trim() ?? "",
  fetchImpl: typeof fetch = fetch,
): Promise<AsanaTask> {
  if (!token) {
    throw new Error("Set ASANA_ACCESS_TOKEN to the Asana personal access token.");
  }
  const fields = TASK_FIELDS;
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

function defaultJobPath(): string {
  return path.join(resolveAgentForgeDataDir(), "readonly-account-asana.json");
}
