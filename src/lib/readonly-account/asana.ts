import fs from "node:fs";
import path from "node:path";

import { resolveAgentForgeDataDir } from "@/lib/db/store";
import {
  asanaAccessToken,
  loadAsanaDesk,
  missingDeskFields,
  sailPointClientForDesk,
  tenantLink,
  type AsanaDeskConfig,
} from "@/lib/readonly-account/asana-desk";
import {
  DEFAULT_ASANA_PROJECT_NAME,
  defaultWebhookStore,
  findProjectGid,
  findSectionGid,
} from "@/lib/readonly-account/asana-webhook";
import {
  accountPassword,
  activateTestAccount,
  createTestAccount,
  findAsanaDriveAccounts,
  findTestAccountByEmail,
  type TenantRefs,
  type TestUser,
} from "@/lib/readonly-account/tenant";

type SailClient = ReturnType<typeof sailPointClientForDesk>;

const ASANA_API = "https://app.asana.com/api/1.0";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TASK_GID = /^[0-9]{5,20}$/;
const LEAD_SE_FIELD = /^lead se$/i;
const DRIVE_STATUS_FIELD = "Test Drive Status";
const DRIVE_STATUS_DONE = "Done";
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
  resetCode?: string;
  resetCodeError?: string;
  failed?: boolean;
};

export type AsanaAccountStatus = {
  accepted: boolean;
  asanaTaskGid: string;
  userId: string;
  email: string;
  done: boolean;
  failed?: boolean;
  detail: string;
};

type AsanaPerson = {
  gid?: string;
  name?: string;
  email?: string | null;
};

type EnumOption = { gid?: string; name?: string };

export type AsanaCustomField = {
  gid?: string;
  name?: string;
  type?: string;
  resource_subtype?: string;
  display_value?: string | null;
  text_value?: string | null;
  enum_value?: { gid?: string; name?: string } | null;
  enum_options?: EnumOption[];
  people_value?: AsanaPerson[] | null;
};

type AsanaTask = {
  name?: string;
  notes?: string;
  custom_type?: { gid?: string; name?: string } | null;
  custom_type_status_option?: { gid?: string; name?: string } | null;
  custom_fields?: AsanaCustomField[];
  memberships?: Array<{ project?: { gid?: string }; section?: { gid?: string; name?: string } }>;
};

type AsanaCallOptions = {
  token?: string;
  fetchImpl?: typeof fetch;
  store?: JobStore;
  random?: () => number;
  client?: SailClient;
  projectGid?: string;
  desk?: AsanaDeskConfig;
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

// A missing or incomplete desk is a gap in the saved configuration, not a problem
// with the task, so nothing is written to the task and no account work starts.
function deskGap(desk: AsanaDeskConfig): string | null {
  const missing = missingDeskFields(desk);
  return missing.length > 0 ? missing.join(", ") : null;
}

function notReady(gid: string, missing: string): AsanaAccountStatus {
  return {
    accepted: false,
    asanaTaskGid: gid,
    userId: "",
    email: "",
    done: false,
    failed: false,
    detail: `No saved back desk was found (${missing}). The task was left unchanged. Save and connect again.`,
  };
}

const taskLocks = new Map<string, Promise<unknown>>();

async function withTaskLock<T>(taskGid: string, run: () => Promise<T>): Promise<T> {
  const previous = taskLocks.get(taskGid) ?? Promise.resolve();
  const next = previous.then(run, run);
  taskLocks.set(taskGid, next);
  try {
    return await next;
  } finally {
    if (taskLocks.get(taskGid) === next) {
      taskLocks.delete(taskGid);
    }
  }
}

function persistJob(store: JobStore, job: AsanaAccountJob) {
  const jobs = store.load();
  const index = jobs.findIndex((item) => item.asanaTaskGid === job.asanaTaskGid);
  if (index >= 0) {
    jobs[index] = job;
  } else {
    jobs.push(job);
  }
  store.save(jobs);
}

export async function acceptAsanaTask(
  taskGid: string,
  options: AsanaCallOptions = {},
): Promise<AsanaAccountStatus> {
  const gid = asanaTaskGid(taskGid);
  return withTaskLock(gid, () => acceptLocked(gid, options));
}

async function acceptLocked(gid: string, options: AsanaCallOptions): Promise<AsanaAccountStatus> {
  const store = options.store ?? fileJobStore();
  const desk = options.desk ?? await loadAsanaDesk();
  const client = options.client ?? sailPointClientForDesk(desk);
  const gap = deskGap(desk);
  if (gap) {
    return notReady(gid, gap);
  }
  const existing = store.load().find((job) => job.asanaTaskGid === gid);
  if (existing?.failed) {
    store.save(store.load().filter((job) => job.asanaTaskGid !== gid));
  } else if (existing) {
    return statusOf(await advanceJob(existing, store, { ...options, client, desk }));
  }
  const opened = await createTestAccount(client, options.random ?? Math.random, "");
  const job: AsanaAccountJob = {
    asanaTaskGid: gid,
    user: opened.user,
    refs: opened.refs,
    sailPointTaskId: opened.taskId,
    processed: false,
    inviteSent: false,
    inviteError: null,
    attempt: 0,
    commented: false,
    detail: "Account requested.",
    createdAt: new Date().toISOString(),
  };
  persistJob(store, job);
  try {
    await writeAccountField(job, { ...options, desk });
  } catch (error) {
    job.detail = error instanceof Error ? error.message : "Asana did not save the account.";
    persistJob(store, job);
  }
  await setTaskStatus(gid, desk.workingStatus, { ...options, desk });
  return statusOf(await advanceJob(job, store, { ...options, client, desk }));
}

export async function resumeAsanaTask(
  taskGid: string,
  options: AsanaCallOptions = {},
): Promise<AsanaAccountStatus | null> {
  const gid = asanaTaskGid(taskGid);
  return withTaskLock(gid, () => resumeLocked(gid, options));
}

async function resumeLocked(gid: string, options: AsanaCallOptions): Promise<AsanaAccountStatus | null> {
  const store = options.store ?? fileJobStore();
  const desk = options.desk ?? await loadAsanaDesk();
  const gap = deskGap(desk);
  if (gap) {
    return notReady(gid, gap);
  }
  const client = options.client ?? sailPointClientForDesk(desk);
  let job = store.load().find((item) => item.asanaTaskGid === gid);
  if (!job) {
    const recovered = await recoverJob(gid, { ...options, client, desk });
    if (!recovered) {
      return null;
    }
    job = recovered;
    persistJob(store, job);
  }
  if (job.commented) {
    return statusOf(job);
  }
  return statusOf(await advanceJob(job, store, { ...options, client, desk }));
}

export async function finishPendingAsanaAccounts(
  options: AsanaCallOptions = {},
): Promise<AsanaAccountStatus[]> {
  const store = options.store ?? fileJobStore();
  const desk = options.desk ?? await loadAsanaDesk();
  if (deskGap(desk)) {
    return [];
  }
  const client = options.client ?? sailPointClientForDesk(desk);
  const discovered = await findAsanaDriveAccounts(client);
  for (const account of discovered) {
    if (store.load().some((job) => job.asanaTaskGid === account.taskGid)) {
      continue;
    }
    const sent = await invitationAlreadySent(account.taskGid, options.token, options.fetchImpl);
    await withTaskLock(account.taskGid, async () => {
      if (store.load().some((job) => job.asanaTaskGid === account.taskGid)) {
        return;
      }
      persistJob(store, {
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
    });
  }
  await resumeWorkingTasks({ ...options, store, client, desk });
  return tickAsanaAccounts({ ...options, store, client, desk });
}

async function resumeWorkingTasks(
  options: AsanaCallOptions & { store: JobStore; client: SailClient; desk: AsanaDeskConfig },
) {
  const token = asanaAccessToken(options.token, options.desk);
  if (!token) {
    return;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const projectGid = await resolveProjectGid(token, fetchImpl, options.projectGid, options.desk);
    const wanted = options.desk.workingStatus.trim().toLowerCase();
    const response = await fetchImpl(
      `${ASANA_API}/projects/${projectGid}/tasks?opt_fields=${encodeURIComponent("name,custom_type_status_option.name")}&limit=100`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!response.ok) {
      return;
    }
    const tasks =
      ((await response.json()) as { data?: Array<{ gid?: string; custom_type_status_option?: { name?: string } }> })
        .data ?? [];
    for (const task of tasks) {
      const name = task.custom_type_status_option?.name?.trim().toLowerCase() ?? "";
      if (!task.gid || name !== wanted) {
        continue;
      }
      await resumeAsanaTask(task.gid, options);
    }
  } catch {
    // The local job list is still finished when the project task list cannot be read.
  }
}

export async function tickAsanaAccounts(
  options: AsanaCallOptions = {},
): Promise<AsanaAccountStatus[]> {
  const store = options.store ?? fileJobStore();
  const desk = options.desk ?? await loadAsanaDesk();
  if (deskGap(desk)) {
    return [];
  }
  const client = options.client ?? sailPointClientForDesk(desk);
  const pending = store.load().filter((job) => !job.commented).slice(0, 5);
  const statuses: AsanaAccountStatus[] = [];
  for (const queued of pending) {
    const gid = queued.asanaTaskGid;
    const status = await withTaskLock(gid, async () => {
      const job = store.load().find((item) => item.asanaTaskGid === gid);
      if (!job) {
        return null;
      }
      try {
        return statusOf(await advanceJob(job, store, { ...options, client, desk }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Account activation failed.";
        await failTask(job, store, message, { ...options, desk });
        return statusOf(job);
      }
    });
    if (status) {
      statuses.push(status);
    }
  }
  return statuses;
}

async function advanceJob(
  job: AsanaAccountJob,
  store: JobStore,
  options: AsanaCallOptions & { client: SailClient; desk: AsanaDeskConfig },
): Promise<AsanaAccountJob> {
  if (job.commented) {
    return job;
  }
  if (!job.user.password) {
    job.user.password = accountPassword();
    persistJob(store, job);
  }
  const result = await activateTestAccount(options.client, {
    ...job.refs,
    userId: job.user.id,
    accountName: job.refs.accountNameIsEmail ? job.user.email : job.user.id,
    taskId: job.sailPointTaskId,
    attempt: job.attempt,
    processed: job.processed,
    password: job.user.password,
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
  if (!result.done) {
    persistJob(store, job);
    return job;
  }
  if (!job.resetCode) {
    try {
      job.resetCode = await passwordResetCode(options.client, signInName(job));
      job.resetCodeError = "";
      persistJob(store, job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "SailPoint did not issue a reset code.";
      job.resetCodeError = reason;
      await failTask(job, store, `Reset code was not issued. ${reason}`, options);
      return job;
    }
  }
  try {
    await writeTaskResult(job, options);
    clearPassword(job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Asana did not save the account.";
    await failTask(job, store, message, options);
    return job;
  }
  persistJob(store, job);
  return job;
}

async function failTask(
  job: AsanaAccountJob,
  store: JobStore,
  message: string,
  options: AsanaCallOptions & { desk: AsanaDeskConfig },
) {
  try {
    const current = await describeTaskStatus(job.asanaTaskGid, {
      token: options.token,
      fetchImpl: options.fetchImpl,
      projectGid: options.projectGid,
      desk: options.desk,
    });
    if (current.trim().toLowerCase() === options.desk.doneStatus.trim().toLowerCase()) {
      clearPassword(job);
      job.failed = false;
      job.detail = `The task is already ${options.desk.doneStatus}.`;
      persistJob(store, job);
      return;
    }
  } catch {
    // An unreadable status must not stop the failure from being recorded on the task.
  }
  job.failed = true;
  job.commented = true;
  job.detail = message;
  job.user = { ...job.user, password: "" };
  persistJob(store, job);
  const token = asanaAccessToken(options.token, options.desk);
  try {
    await commentAsanaOnce(job.asanaTaskGid, `SAF Test Drive\n${message}`, token, options.fetchImpl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Asana did not save the comment.";
    job.detail = `${message} ${reason}`;
  }
  try {
    await setTaskStatus(job.asanaTaskGid, options.desk.declinedStatus, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Asana did not set Declined.";
    job.detail = `${job.detail} ${reason}`;
  }
  persistJob(store, job);
}

export async function declineAsanaTask(taskGid: string, options: AsanaCallOptions = {}): Promise<void> {
  const desk = options.desk ?? await loadAsanaDesk();
  await setTaskStatus(taskGid, desk.declinedStatus, { ...options, desk });
}

function signInName(job: AsanaAccountJob): string {
  return job.refs.accountNameIsEmail ? job.user.email : job.user.id;
}

function clearPassword(job: AsanaAccountJob) {
  job.commented = true;
  job.user = { ...job.user, password: "" };
  job.resetCode = "";
}

async function passwordResetCode(client: SailClient, userId: string): Promise<string> {
  const response = await client.request("POST", "/v2025/generate-password-reset-token/digit", {
    userId,
    length: 6,
    durationMinutes: 60,
  });
  const code =
    response && typeof response === "object" && "digitToken" in response
      ? String((response as { digitToken?: unknown }).digitToken ?? "").trim()
      : "";
  if (!code) {
    throw new Error("SailPoint did not return a reset code.");
  }
  return code;
}

export function statusField(
  fields: AsanaCustomField[],
  names: { triggerStatus: string; workingStatus: string; doneStatus: string },
): AsanaCustomField | null {
  const wanted = [names.triggerStatus, names.workingStatus, names.doneStatus].map((name) =>
    name.trim().toLowerCase(),
  );
  return (
    fields.find((field) => {
      const options = (field.enum_options ?? []).map((option) => (option.name ?? "").trim().toLowerCase());
      return wanted.every((name) => options.includes(name));
    }) ?? null
  );
}

export function fieldByName(fields: AsanaCustomField[], name: string): AsanaCustomField | null {
  const wanted = name.trim().toLowerCase();
  return fields.find((field) => (field.name ?? "").trim().toLowerCase() === wanted) ?? null;
}

export async function describeTaskStatus(
  taskGid: string,
  options: AsanaCallOptions = {},
): Promise<string> {
  const desk = options.desk ?? await loadAsanaDesk();
  const token = asanaAccessToken(options.token, desk);
  const fetchImpl = options.fetchImpl ?? fetch;
  const task = await fetchAsanaTask(taskGid, token, fetchImpl, true);
  const taskTypeStatus = task.custom_type_status_option?.name?.trim() ?? "";
  if (taskTypeStatus) {
    return taskTypeStatus;
  }
  const projectGid = await resolveProjectGid(
    token,
    fetchImpl,
    options.projectGid || task.memberships?.find((membership) => membership.project?.gid)?.project?.gid,
    desk,
  );
  const fields = await projectCustomFields(projectGid, token, fetchImpl);
  const status = statusField(fields, desk);
  if (status?.gid) {
    const value = (task.custom_fields ?? []).find((field) => field.gid === status.gid);
    return (value?.enum_value?.name || value?.display_value || "").trim();
  }
  return sectionName(task, projectGid, desk).trim();
}

export async function taskHasTriggerStatus(
  taskGid: string,
  options: AsanaCallOptions = {},
): Promise<boolean> {
  const desk = options.desk ?? await loadAsanaDesk();
  const name = await describeTaskStatus(taskGid, options);
  return name.toLowerCase() === desk.triggerStatus.trim().toLowerCase();
}

function sectionName(task: AsanaTask, projectGid: string, desk: AsanaDeskConfig): string {
  const memberships = task.memberships ?? [];
  const inProject = memberships.find((membership) => membership.project?.gid === projectGid);
  if (inProject?.section?.name) {
    return inProject.section.name;
  }
  const known = [desk.triggerStatus, desk.workingStatus, desk.doneStatus].map((name) =>
    name.trim().toLowerCase(),
  );
  const named = memberships.find((membership) =>
    known.includes((membership.section?.name ?? "").trim().toLowerCase()),
  );
  return named?.section?.name || memberships.find((membership) => membership.section?.name)?.section?.name || "";
}

async function setTaskStatus(taskGid: string, statusName: string, options: AsanaCallOptions) {
  const desk = options.desk ?? await loadAsanaDesk();
  const token = asanaAccessToken(options.token, desk);
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectGid = await resolveProjectGid(token, fetchImpl, options.projectGid, desk);
  const task = await fetchAsanaTask(taskGid, token, fetchImpl, true);
  if (task.custom_type_status_option) {
    await putTaskTypeStatus(taskGid, task, statusName, projectGid, token, fetchImpl);
    return;
  }
  const fields = await projectCustomFields(projectGid, token, fetchImpl);
  const status = statusField(fields, desk);
  if (status?.gid) {
    await putCustomFields(
      taskGid,
      { [requireGid(status, "status")]: enumOptionGid(status, statusName) },
      token,
      fetchImpl,
    );
    return;
  }
  await moveTaskToNamedSection(taskGid, statusName, projectGid, token, fetchImpl);
}

async function taskTypeStatusOptionGid(
  task: AsanaTask,
  statusName: string,
  projectGid: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  type StatusOption = { gid?: string; name?: string; enabled?: boolean };
  type TaskType = { gid?: string; status_options?: StatusOption[] };
  const optFields = encodeURIComponent(
    "name,status_options,status_options.gid,status_options.name,status_options.enabled",
  );
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const wanted = statusName.trim().toLowerCase();
  const find = (types: TaskType[]) => {
    for (const type of types) {
      const option = (type.status_options ?? []).find(
        (item) =>
          item.enabled !== false &&
          item.gid &&
          item.gid !== "undefined" &&
          (item.name ?? "").trim().toLowerCase() === wanted,
      );
      if (option?.gid) {
        return option.gid;
      }
    }
    return "";
  };
  const listed = await fetchImpl(`${ASANA_API}/custom_types?project=${projectGid}&opt_fields=${optFields}`, {
    headers,
  });
  if (!listed.ok) {
    throw new Error(`Asana did not return the task types (${listed.status}).`);
  }
  const types = ((await listed.json()) as { data?: TaskType[] }).data ?? [];
  const own = task.custom_type?.gid ? types.filter((type) => type.gid === task.custom_type?.gid) : types;
  const found = find(own.length > 0 ? own : types);
  if (found) {
    return found;
  }
  if (task.custom_type?.gid) {
    const single = await fetchImpl(`${ASANA_API}/custom_types/${task.custom_type.gid}?opt_fields=${optFields}`, {
      headers,
    });
    if (single.ok) {
      const type = ((await single.json()) as { data?: TaskType }).data;
      const option = type ? find([type]) : "";
      if (option) {
        return option;
      }
    }
  }
  throw new Error(`Asana status "${statusName}" was not found.`);
}

async function putTaskTypeStatus(
  taskGid: string,
  task: AsanaTask,
  statusName: string,
  projectGid: string,
  token: string,
  fetchImpl: typeof fetch,
) {
  const optionGid = await taskTypeStatusOptionGid(task, statusName, projectGid, token, fetchImpl);
  const response = await fetchImpl(`${ASANA_API}/tasks/${taskGid}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: { resource_subtype: "custom", custom_type_status_option: optionGid },
    }),
  });
  if (!response.ok) {
    throw new Error(`Asana did not set the status ${statusName} (${response.status}).`);
  }
}

async function writeAccountField(
  job: AsanaAccountJob,
  options: AsanaCallOptions & { desk: AsanaDeskConfig },
) {
  const token = asanaAccessToken(options.token, options.desk);
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectGid = await resolveProjectGid(token, fetchImpl, options.projectGid, options.desk);
  const fields = await projectCustomFields(projectGid, token, fetchImpl);
  const account = requireNamedField(fields, options.desk.accountField);
  await putCustomFields(
    job.asanaTaskGid,
    { [requireGid(account, options.desk.accountField)]: job.user.email },
    token,
    fetchImpl,
  );
}

async function recoverJob(
  taskGid: string,
  options: AsanaCallOptions & { client: SailClient; desk: AsanaDeskConfig },
): Promise<AsanaAccountJob | null> {
  const token = asanaAccessToken(options.token, options.desk);
  const fetchImpl = options.fetchImpl ?? fetch;
  const task = await fetchAsanaTask(taskGid, token, fetchImpl, true);
  const projectGid = await resolveProjectGid(
    token,
    fetchImpl,
    options.projectGid || task.memberships?.find((membership) => membership.project?.gid)?.project?.gid,
    options.desk,
  );
  const fields = await projectCustomFields(projectGid, token, fetchImpl);
  const accountField = fieldByName(fields, options.desk.accountField);
  const value = (task.custom_fields ?? []).find((field) => field.gid === accountField?.gid);
  const email = (value?.text_value || value?.display_value || "").trim();
  if (!EMAIL.test(email)) {
    return null;
  }
  const found = await findTestAccountByEmail(options.client, email);
  if (!found) {
    return null;
  }
  return {
    asanaTaskGid: taskGid,
    user: found.user,
    refs: found.refs,
    sailPointTaskId: null,
    processed: false,
    inviteSent: false,
    inviteError: null,
    attempt: 0,
    commented: false,
    detail: "Account already exists for this Asana task.",
    createdAt: new Date().toISOString(),
  };
}

async function writeTaskResult(
  job: AsanaAccountJob,
  options: AsanaCallOptions & { desk: AsanaDeskConfig },
) {
  if (!options.desk.tenantLinkField) {
    throw new Error("Set the tenant link field in the back desk.");
  }
  const token = asanaAccessToken(options.token, options.desk);
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectGid = await resolveProjectGid(token, fetchImpl, options.projectGid, options.desk);
  const fields = await projectCustomFields(projectGid, token, fetchImpl);
  const task = await fetchAsanaTask(job.asanaTaskGid, token, fetchImpl, true);
  const taskType = Boolean(task.custom_type_status_option);
  const status = taskType ? null : statusField(fields, options.desk);
  const account = requireNamedField(fields, options.desk.accountField);
  const code = requireNamedField(fields, options.desk.codeField);
  const link = requireNamedField(fields, options.desk.tenantLinkField);
  const drive = requireNamedField(fields, DRIVE_STATUS_FIELD);
  const linkValue = tenantLink(options.desk);
  const values: Record<string, string> = {
    [requireGid(account, options.desk.accountField)]: job.user.email,
    [requireGid(code, options.desk.codeField)]: job.resetCode ?? "",
    [requireGid(link, options.desk.tenantLinkField)]: linkValue,
    [requireGid(drive, DRIVE_STATUS_FIELD)]: enumOptionGid(drive, DRIVE_STATUS_DONE),
  };
  if (status?.gid) {
    values[requireGid(status, "status")] = enumOptionGid(status, options.desk.doneStatus);
  }
  const notes = appendFulfillmentNotes(task.notes ?? "", {
    tenantLink: linkValue,
    sandboxAccount: job.user.email,
    initialPassword: job.resetCode ?? "",
  });
  await putCustomFields(job.asanaTaskGid, values, token, fetchImpl, notes);
  if (taskType) {
    await putTaskTypeStatus(job.asanaTaskGid, task, options.desk.doneStatus, projectGid, token, fetchImpl);
  } else if (!status?.gid) {
    await moveTaskToNamedSection(job.asanaTaskGid, options.desk.doneStatus, projectGid, token, fetchImpl);
  }
}

async function moveTaskToNamedSection(
  taskGid: string,
  sectionName: string,
  projectGid: string,
  token: string,
  fetchImpl: typeof fetch,
) {
  const sectionGid = await findSectionGid(token, projectGid, sectionName, fetchImpl);
  const response = await fetchImpl(`${ASANA_API}/sections/${sectionGid}/addTask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ data: { task: taskGid } }),
  });
  if (!response.ok) {
    throw new Error(`Asana did not move the task to ${sectionName} (${response.status}).`);
  }
}

function requireNamedField(fields: AsanaCustomField[], name: string): AsanaCustomField {
  const field = fieldByName(fields, name);
  if (!field?.gid) {
    throw new Error(`Asana field "${name}" was not found.`);
  }
  return field;
}

function requireGid(field: AsanaCustomField, label: string): string {
  if (!field.gid) {
    throw new Error(`Asana field "${label}" was not found.`);
  }
  return field.gid;
}

function enumOptionGid(field: AsanaCustomField, name: string): string {
  const option = (field.enum_options ?? []).find(
    (item) => (item.name ?? "").trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (!option?.gid) {
    throw new Error(`Asana status "${name}" was not found.`);
  }
  return option.gid;
}

async function projectCustomFields(
  projectGid: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AsanaCustomField[]> {
  const response = await fetchImpl(
    `${ASANA_API}/projects/${projectGid}/custom_field_settings?opt_fields=${encodeURIComponent(
      "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name",
    )}&limit=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Asana did not return project fields (${response.status}).`);
  }
  const body = (await response.json()) as {
    data?: Array<{ custom_field?: AsanaCustomField }>;
  };
  return (body.data ?? []).flatMap((setting) => (setting.custom_field ? [setting.custom_field] : []));
}

const FULFILLMENT_MARKER = "--- FULFILLMENT DETAILS ---";

function appendFulfillmentNotes(
  existingNotes: string,
  details: { tenantLink: string; sandboxAccount: string; initialPassword: string },
): string {
  const markerAt = existingNotes.indexOf(FULFILLMENT_MARKER);
  const kept = (markerAt >= 0 ? existingNotes.slice(0, markerAt) : existingNotes).replace(/\s+$/, "");
  const credentialBlock = `${FULFILLMENT_MARKER}
TENANT_LINK: ${details.tenantLink}
SANDBOX_ACCOUNT: ${details.sandboxAccount}
INITIAL_PASSWORD: ${details.initialPassword}
`;
  return kept ? `${kept}\n${credentialBlock}` : credentialBlock;
}

async function putCustomFields(
  taskGid: string,
  values: Record<string, string>,
  token: string,
  fetchImpl: typeof fetch = fetch,
  notes?: string,
) {
  if (!token) {
    throw new Error("Set the Asana access token in the back desk.");
  }
  const data: { custom_fields: Record<string, string>; notes?: string } = { custom_fields: values };
  if (notes !== undefined) {
    data.notes = notes;
  }
  const response = await fetchImpl(`${ASANA_API}/tasks/${taskGid}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data }),
  });
  if (!response.ok) {
    throw new Error(`Asana did not update the task (${response.status}).`);
  }
}

async function resolveProjectGid(
  token: string,
  fetchImpl: typeof fetch,
  projectGid: string | undefined,
  desk: AsanaDeskConfig,
): Promise<string> {
  const given = projectGid?.trim() || "";
  if (given) {
    return given;
  }
  const stored = (await defaultWebhookStore().load())?.projectGid?.trim() ?? "";
  if (stored) {
    return stored;
  }
  const fromEnv = process.env.ASANA_PROJECT_GID?.trim() || "";
  try {
    return await findProjectGid(token, desk.projectName || DEFAULT_ASANA_PROJECT_NAME, fetchImpl);
  } catch (error) {
    if (fromEnv) {
      return fromEnv;
    }
    throw error;
  }
}

async function leadSeEmail(
  lead: LeadSe,
  token = "",
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const asanaToken = asanaAccessToken(token);
  if (EMAIL.test(lead.email)) {
    return lead.email;
  }
  if (!lead.gid) {
    throw new Error("The task needs a Lead SE.");
  }
  if (!asanaToken) {
    throw new Error("Set the Asana access token in the back desk.");
  }
  const response = await fetchImpl(
    `${ASANA_API}/users/${lead.gid}?opt_fields=${encodeURIComponent("email,name")}`,
    { headers: { Authorization: `Bearer ${asanaToken}`, Accept: "application/json" } },
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
    failed: job.failed === true,
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
  token = "",
  fetchImpl: typeof fetch = fetch,
  includeStatus = false,
): Promise<AsanaTask> {
  const asanaToken = asanaAccessToken(token);
  if (!asanaToken) {
    throw new Error("Set the Asana access token in the back desk.");
  }
  const fields = includeStatus
    ? `${TASK_FIELDS},notes,custom_type.gid,custom_type.name,custom_type_status_option.gid,custom_type_status_option.name,custom_fields.gid,custom_fields.enum_value,custom_fields.enum_value.name,custom_fields.display_value,custom_fields.text_value,memberships.project.gid,memberships.section.gid,memberships.section.name`
    : TASK_FIELDS;
  const response = await fetchImpl(
    `${ASANA_API}/tasks/${taskGid}?opt_fields=${encodeURIComponent(fields)}`,
    { headers: { Authorization: `Bearer ${asanaToken}`, Accept: "application/json" } },
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
  token = "",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const asanaToken = asanaAccessToken(token);
  if (!asanaToken) {
    throw new Error("Set the Asana access token in the back desk.");
  }
  const listed = await fetchImpl(
    `${ASANA_API}/tasks/${taskGid}/stories?opt_fields=text&limit=20`,
    { headers: { Authorization: `Bearer ${asanaToken}`, Accept: "application/json" } },
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
      Authorization: `Bearer ${asanaToken}`,
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
