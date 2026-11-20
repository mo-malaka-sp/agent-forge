import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SLACK_POC_CHANNEL_ID,
  slackPocChannelId,
  describeSlackSyncResult,
  syncAsanaSlackStatus,
  taskGidsForSignedDelivery,
  type SlackSyncOptions,
} from "@/lib/readonly-account/asana-slack-sync";
import type { SafPocStore } from "@/lib/saf-poc/storage";

const PROJECT = "1200000000000001";
const TASK = "1234567890123";
const THREAD = "1795138819.813139";
const CHANNEL = "C0CK03K8QF3";
const NOW = 1_700_000_000_000;

type SlackPost = {
  channel: string;
  thread_ts: string;
  text: string;
};

function memoryStore(): SafPocStore {
  const docs = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return (docs.get(key) as T | undefined) ?? null;
    },
    async put<T>(key: string, value: T) {
      docs.set(key, value);
    },
    async delete(key: string) {
      docs.delete(key);
    },
    async list() {
      return [];
    },
  };
}

function asanaTask(options: {
  status?: string;
  taskTypeStatus?: string;
  section?: string;
  customer?: string;
  threadTs?: string;
  projectGid?: string;
  name?: string;
  omitStatus?: boolean;
  omitCustomer?: boolean;
} = {}) {
  const projectGid = options.projectGid ?? PROJECT;
  const fields: Array<Record<string, unknown>> = [
    {
      name: "Slack Thread TS",
      text_value: options.threadTs ?? THREAD,
      display_value: null,
      enum_value: null,
    },
  ];
  if (!options.omitStatus) {
    fields.push({
      name: "POC Status",
      enum_value: { name: options.status ?? "Completed" },
      display_value: "Ready for TES",
      text_value: "Ready for TES",
    });
  }
  if (!options.omitCustomer) {
    fields.push({
      name: "Customer",
      text_value: options.customer ?? "State Farm",
      display_value: null,
      enum_value: null,
    });
  }
  return {
    name: options.name ?? "State Farm request",
    custom_type_status_option: options.taskTypeStatus ? { name: options.taskTypeStatus } : null,
    projects: [{ gid: projectGid }],
    memberships: [{ project: { gid: projectGid }, section: { name: options.section ?? "Ready for TES" } }],
    custom_fields: fields,
  };
}

function capture(task: ReturnType<typeof asanaTask> | { fail: true }) {
  const slack: SlackPost[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls += 1;
    const target = String(url);
    if (target.includes("slack.com")) {
      slack.push(JSON.parse(String(init?.body)) as SlackPost);
      const headers = init?.headers as { Authorization?: string } | undefined;
      assert.equal(headers?.Authorization, "Bearer xoxb-test");
      return Response.json({ ok: true });
    }
    assert.match(target, new RegExp(`/tasks/${TASK}\\?`));
    const headers = init?.headers as { Authorization?: string } | undefined;
    assert.equal(headers?.Authorization, "Bearer asana-token");
    if ("fail" in task) {
      return Response.json({ errors: [{ message: "nope" }] }, { status: 500 });
    }
    return Response.json({ data: task });
  };
  return { slack, fetchImpl, calls: () => calls };
}

function syncOptions(
  fetchImpl: typeof fetch,
  extra: Partial<SlackSyncOptions> = {},
): SlackSyncOptions {
  return {
    asanaToken: "asana-token",
    projectGid: PROJECT,
    fetchImpl,
    store: memoryStore(),
    cache: new Map(),
    now: () => NOW,
    slackToken: "xoxb-test",
    channelId: CHANNEL,
    ...extra,
  };
}

describe("Asana Slack status sync", () => {
  it("ignores a rejected receipt and keeps only added or changed tasks", () => {
    const body = JSON.stringify({
      events: [
        { action: "changed", resource: { gid: TASK, resource_type: "task" } },
        {
          action: "added",
          resource: { gid: "1234567890126", resource_type: "story" },
          parent: { gid: "1234567890127", resource_type: "task" },
        },
        { action: "removed", resource: { gid: "1234567890125", resource_type: "task" } },
        { action: "changed", resource: { gid: "12", resource_type: "task" } },
      ],
    });
    assert.deepEqual(taskGidsForSignedDelivery(401, body), []);
    assert.deepEqual(taskGidsForSignedDelivery(200, ""), []);
    assert.deepEqual(taskGidsForSignedDelivery(200, "not-json"), []);
    assert.deepEqual(taskGidsForSignedDelivery(200, JSON.stringify({ events: [] })), []);
    // A story event names the task as its parent, so the task is included.
    assert.deepEqual(taskGidsForSignedDelivery(200, body), [TASK, "1234567890127"]);
  });

  it("names the task when Asana sends a custom field change with the task as parent", () => {
    const body = JSON.stringify({
      events: [
        {
          action: "changed",
          resource: { gid: "1200000000000555", resource_type: "custom_field" },
          parent: { gid: TASK, resource_type: "task" },
        },
      ],
    });
    assert.deepEqual(taskGidsForSignedDelivery(200, body), [TASK]);
  });

  it("does not post when the signed delivery produced no tasks", async () => {
    const seen = capture(asanaTask());
    await syncAsanaSlackStatus([], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack, []);
    assert.equal(seen.calls(), 0);
  });

  it("posts the downstream templates and escapes the customer", async () => {
    const cases: Array<{ status: string; text: string; customer?: string }> = [
      {
        status: "Active Provisioning",
        customer: "Northwind <!channel> & Co",
        text: "⚡ *Status Update: Active Provisioning*\n_TES team has picked up the request for *Northwind &lt;!channel&gt; &amp; Co*. Environment sandbox is currently being provisioned._",
      },
      {
        status: "Provisioning Active",
        text: "⚡ *Status Update: Active Provisioning*\n_TES team has picked up the request for *State Farm*. Environment sandbox is currently being provisioned._",
      },
      {
        status: "Implemented / Live",
        text: "🟢 *Status Update: Implemented / Live*\n🎉 _The POC environment for *State Farm* is now live! Secure credentials have been delivered via Slack DM._",
      },
      {
        status: "Completed",
        text: "🏁 *Status Update: Completed*\n_The POC engagement for *State Farm* has been marked as completed. Environment is scheduled for clean tear-down._",
      },
      {
        status: "Rejected",
        text: "❌ *Status Update: Rejected*\n_This POC request for *State Farm* has been closed/rejected._",
      },
    ];
    for (const item of cases) {
      const seen = capture(asanaTask({ status: item.status, customer: item.customer }));
      await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
      assert.deepEqual(seen.slack, [{ channel: CHANNEL, thread_ts: THREAD, text: item.text }]);
    }
  });

  it("uses the custom task type status for a POC Request task", async () => {
    const seen = capture(asanaTask({ taskTypeStatus: "Implemented / Live", status: "Ready for TES" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.equal(seen.slack.length, 1);
    assert.match(seen.slack[0]?.text ?? "", /Implemented \/ Live/);
  });

  it("does not post an upstream custom task type status", async () => {
    const seen = capture(asanaTask({ taskTypeStatus: "Pending GVP Approval", section: "Completed" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack, []);
  });

  it("uses the section name when POC Status is empty", async () => {
    const seen = capture(asanaTask({ omitStatus: true, section: "Implemented / Live" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.equal(seen.slack.length, 1);
    assert.match(seen.slack[0]?.text ?? "", /Implemented \/ Live/);
  });

  it("keeps an upstream POC Status even when the section is downstream", async () => {
    const seen = capture(asanaTask({ status: "Ready for TES", section: "Completed" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack, []);
  });

  it("does not post upstream statuses", async () => {
    for (const status of ["Ready for TES", "New Requests", "Pending ATS Approval", "Pending GVP Approval", "Agreement Validation"]) {
      const seen = capture(asanaTask({ status }));
      await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
      assert.deepEqual(seen.slack, [], status);
    }
  });

  it("posts a thread timestamp that has no fraction", async () => {
    const seen = capture(asanaTask({ status: "Completed", threadTs: "1795138819" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack.map((post) => post.thread_ts), ["1795138819"]);
  });

  it("does not post a thread timestamp that is not a Slack timestamp", async () => {
    const seen = capture(asanaTask({ status: "Completed", threadTs: "not-a-timestamp" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack, []);
  });

  it("does not post a task outside the project", async () => {
    const seen = capture(asanaTask({ status: "Completed", projectGid: "9990000000000001" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.deepEqual(seen.slack, []);
    assert.ok(seen.calls() > 0);
  });

  it("does not post when the project is unknown", async () => {
    const seen = capture(asanaTask({ status: "Completed" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { projectGid: "" }));
    assert.deepEqual(seen.slack, []);
    assert.equal(seen.calls(), 0);
  });

  it("posts once within 60 seconds across a fresh cache", async () => {
    const store = memoryStore();
    const seen = capture(asanaTask({ status: "Completed" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { store, cache: new Map() }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { store, cache: new Map() }));
    assert.equal(seen.slack.length, 1);
  });

  it("posts once within 60 seconds on the same server when the store is unavailable", async () => {
    const cache = new Map<string, number>();
    const seen = capture(asanaTask({ status: "Rejected" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { store: null, cache }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { store: null, cache }));
    assert.equal(seen.slack.length, 1);
  });

  it("does not retry a failed post inside the dedup window", async () => {
    let slackCalls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).includes("slack.com")) {
        slackCalls += 1;
        throw new Error("socket hang up");
      }
      return Response.json({ data: asanaTask({ status: "Completed" }) });
    };
    const store = memoryStore();
    await syncAsanaSlackStatus([TASK], syncOptions(fetchImpl, { store, cache: new Map() }));
    await syncAsanaSlackStatus([TASK], syncOptions(fetchImpl, { store, cache: new Map() }));
    assert.equal(slackCalls, 1);
  });

  it("returns without calling Slack when the bot token is missing", async () => {
    const previous = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      const seen = capture(asanaTask({ status: "Completed" }));
      await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl, { slackToken: undefined }));
      assert.deepEqual(seen.slack, []);
      assert.equal(seen.calls(), 0);
    } finally {
      if (previous === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previous;
      }
    }
  });

  it("uses the default POC channel when none is configured", () => {
    const previous = process.env.SLACK_POC_CHANNEL_ID;
    delete process.env.SLACK_POC_CHANNEL_ID;
    try {
      assert.equal(slackPocChannelId(), DEFAULT_SLACK_POC_CHANNEL_ID);
      assert.equal(DEFAULT_SLACK_POC_CHANNEL_ID, "C0CK03K8QF3");
    } finally {
      if (previous === undefined) {
        delete process.env.SLACK_POC_CHANNEL_ID;
      } else {
        process.env.SLACK_POC_CHANNEL_ID = previous;
      }
    }
  });

  it("describes a posted update for the POC Tracker log", async () => {
    const seen = capture(asanaTask({ status: "Completed" }));
    const results = await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.equal(
      describeSlackSyncResult(results[0]!),
      `Task ${TASK} is Completed. Posted to the Slack thread.`,
    );
  });

  it("uses the task name when the customer field is empty", async () => {
    const seen = capture(asanaTask({ status: "Rejected", omitCustomer: true, name: "Globex" }));
    await syncAsanaSlackStatus([TASK], syncOptions(seen.fetchImpl));
    assert.match(seen.slack[0]?.text ?? "", /\*Globex\*/);
  });
});
