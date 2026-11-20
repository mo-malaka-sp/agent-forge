# Feature Specification: Asana-to-Slack Thread Status Synchronization

## 1. Overview & Objective
Implement a secure, event-driven webhook listener in **AgentForge** (AWS Amplify / Node.js / TypeScript backend) that receives real-time task section/status movement events from the **Asana** project `POC Gateway - Request Management`. 

When a task is moved into downstream fulfillment lanes (`Active Provisioning`, `Implemented / Live`, `Completed`, or `Rejected`), AgentForge must:
1. Validate the incoming Asana webhook cryptographic signature (`X-Hook-Signature`).
2. Fetch the task's custom fields from the Asana REST API.
3. Extract the stored Slack thread coordinates (`Slack Thread TS`, `POC Status`, `Customer`).
4. Post a formatted, threaded status reply directly back to the parent conversation in Slack (`#saf-poc-requests` / Channel ID: `C0CK03K8QF3`) using the approved Slack Bot (`xoxb-` token).

---

## 2. System Architecture & Data Flow

```text
[Asana Project: POC Gateway - Request Management]
       │
       │ 1. User drags task to "Active Provisioning", "Implemented / Live", or "Completed"
       │ 2. Asana fires POST /api/webhooks/asana-poc-gateway (with X-Hook-Secret or X-Hook-Signature)
       ▼
[AgentForge Backend API Route]
       │
       ├─► Step A: If `X-Hook-Secret` header is present -> Respond 200 OK with `X-Hook-Secret` header (Handshake)
       ├─► Step B: Validate `X-Hook-Signature` using HMAC-SHA256 against raw request body
       ├─► Step C: Filter events for `task` section movements or `POC Status` custom field changes
       ├─► Step D: Fetch full Task details via Asana API (`GET /tasks/{task_gid}`)
       ├─► Step E: Validate `Slack Thread TS` format (`^\d+\.\d+$`) & deduplicate event
       ▼
[Slack Web API: POST https://slack.com/api/chat.postMessage]
       │
       └─► Posts threaded update to Channel `C0CK03K8QF3` with `thread_ts = Slack Thread TS`
```

---

## 3. Environment Variables & Secrets Management
**CRITICAL SECURITY RULE:** Never hardcode credentials, tokens, or secrets in source code. Load all sensitive values strictly from environment variables (backed by AWS Secrets Manager / Amplify Environment Variables):

```env
# Asana Credentials
ASANA_PAT="your_asana_service_account_pat"
ASANA_WEBHOOK_SECRET="shared_secret_established_during_webhook_handshake"
ASANA_POC_PROJECT_GID="your_poc_gateway_project_gid"

# Slack Credentials
SLACK_BOT_TOKEN="xoxb-your-approved-bot-token"
SLACK_POC_CHANNEL_ID="C0CK03K8QF3"
```

---

## 4. Enterprise Security Requirements (Mandatory)

Cursor must enforce the following security controls in the implementation:

1. **Cryptographic Webhook Verification (HMAC-SHA256):**
   - Handle Asana's initial webhook handshake: if the request contains the `X-Hook-Secret` header, echo the exact header back with a `200 OK` status and store/verify against `ASANA_WEBHOOK_SECRET`.
   - For all subsequent event payloads, verify the `X-Hook-Signature` header by computing an `HMAC-SHA256` hex digest of the **raw request body** using `ASANA_WEBHOOK_SECRET`.
   - Use `crypto.timingSafeEqual()` to prevent timing attacks. Reject invalid signatures immediately with `401 Unauthorized`.

2. **Input Validation & Sanitization:**
   - Validate `taskGid` as strictly numeric (`^\d+$`).
   - Validate `Slack Thread TS` fetched from Asana custom fields against the strict Slack timestamp regex: `^\d+\.\d+$`.
   - Escape user-supplied strings (such as `Customer` name) to prevent Slack mrkdwn injection or unexpected mentions (`<!here>`, `<!channel>`).

3. **Principle of Least Privilege (Scoped Execution):**
   - Verify that the fetched Asana task belongs to `ASANA_POC_PROJECT_GID` before dispatching any Slack message.
   - Restrict Slack `chat.postMessage` egress strictly to `process.env.SLACK_POC_CHANNEL_ID` (`C0CK03K8QF3`).

4. **Idempotency & Deduplication (Loop Prevention):**
   - Asana webhooks may fire multiple events for a single drag-and-drop action (e.g., `section_changed` + `custom_field_changed` from Asana's internal lane-sync rule) or retry on timeout.
   - Respond `200 OK` to Asana within 3 seconds, or process asynchronously, and maintain a short-lived in-memory/DynamoDB cache keyed by `${taskGid}:${pocStatus}` (TTL: 60 seconds) so duplicate webhook deliveries do not spam the Slack thread.

5. **Safe Error Handling & Observability:**
   - Never leak stack traces, token fragments, or internal metadata in HTTP error responses.
   - Log structured JSON audit events (`timestamp`, `taskGid`, `targetStatus`, `slackThreadTs`, `deliveryStatus`) for Datadog / CloudWatch monitoring.

---

## 5. Target Status Mapping & Slack Message Templates

Only trigger Slack thread replies when `POC Status` (or the task's current section name) transitions into one of the following target fulfillment stages:

| Asana Section / `POC Status` | Icon | Threaded Message Format |
| :--- | :--- | :--- |
| **`Active Provisioning`** *(or `Provisioning Active`)* | ⚡ | `⚡ *Status Update: Active Provisioning*\n_TES team has picked up the request for *{Customer}*. Environment sandbox is currently being provisioned._` |
| **`Implemented / Live`** | 🟢 | `🟢 *Status Update: Implemented / Live*\n🎉 _The POC environment for *{Customer}* is now live! Secure credentials have been delivered via Slack DM._` |
| **`Completed`** | 🏁 | `🏁 *Status Update: Completed*\n_The POC engagement for *{Customer}* has been marked as completed. Environment is scheduled for clean tear-down._` |
| **`Rejected`** | ❌ | `❌ *Status Update: Rejected*\n_This POC request for *{Customer}* has been closed/rejected._` |

*(Note: Ignore earlier stages like `New Requests`, `Pending ATS Approval`, `Pending GVP Approval`, `Agreement Validation`, and `Ready for TES` as those are already posted by Slack Workflow Builder).*

---

## 6. Reference Implementation (TypeScript / Node.js)

Use the following modular structure as the foundation in AgentForge:

### `src/utils/security.ts`
```typescript
import crypto from 'crypto';

/**
 * Validates Asana's X-Hook-Signature using timing-safe HMAC-SHA256 comparison.
 */
export function verifyAsanaSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !secret) return false;

  const computedHash = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(signatureHeader, 'utf8');
  const computedBuffer = Buffer.from(computedHash, 'utf8');

  if (expectedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
}

/**
 * Sanitizes text before inserting into Slack mrkdwn to prevent injection.
 */
export function sanitizeSlackText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Validates Slack Thread Timestamp format (e.g., "1795138819.813139" or numeric string).
 */
export function isValidThreadTs(ts: string): boolean {
  return /^\d+(\.\d+)?$/.test(ts.trim());
}
```

### `src/services/asanaSlackSync.ts`
```typescript
import axios from 'axios';
import { isValidThreadTs, sanitizeSlackText } from '../utils/security';

// Simple TTL deduplication cache to prevent duplicate Slack posts per status transition
const processedTransitions = new Map<string, number>();
const DEDUP_TTL_MS = 60 * 1000; // 60 seconds

const NOTIFIABLE_STATUSES = [
  'Active Provisioning',
  'Provisioning Active',
  'Implemented / Live',
  'Completed',
  'Rejected'
];

export async function processAsanaTaskUpdate(taskGid: string): Promise<void> {
  if (!/^\d+$/.test(taskGid)) {
    console.warn(JSON.stringify({ event: 'invalid_task_gid', taskGid }));
    return;
  }

  const asanaPat = process.env.ASANA_PAT;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const targetChannel = process.env.SLACK_POC_CHANNEL_ID || 'C0CK03K8QF3';
  const expectedProjectGid = process.env.ASANA_POC_PROJECT_GID;

  if (!asanaPat || !slackBotToken) {
    console.error(JSON.stringify({ event: 'missing_credentials_env' }));
    return;
  }

  // 1. Fetch full Task metadata from Asana
  const taskUrl = `https://app.asana.com/api/1.0/tasks/${taskGid}?opt_fields=name,projects.gid,memberships.section.name,custom_fields.name,custom_fields.text_value,custom_fields.display_value`;
  const asanaRes = await axios.get(taskUrl, {
    headers: { Authorization: `Bearer ${asanaPat}` },
    timeout: 5000
  });

  const task = asanaRes.data?.data;
  if (!task) return;

  // 2. Enforce Project Scope
  if (expectedProjectGid) {
    const inTargetProject = (task.projects || []).some(
      (p: { gid: string }) => p.gid === expectedProjectGid
    );
    if (!inTargetProject) {
      return; // Ignore tasks outside POC Gateway project
    }
  }

  const customFields: Array<{
    name?: string;
    text_value?: string;
    display_value?: string;
  }> = task.custom_fields || [];

  const getCustomField = (fieldName: string): string => {
    const found = customFields.find(
      (f) => f.name && f.name.trim().toLowerCase().includes(fieldName.toLowerCase())
    );
    return found ? (found.text_value || found.display_value || '').trim() : '';
  };

  const slackThreadTs = getCustomField('Slack Thread TS');
  const pocStatus = getCustomField('POC Status');
  const rawCustomer = getCustomField('Customer') || task.name || 'POC Request';
  const customer = sanitizeSlackText(rawCustomer);

  // 3. Validate Thread TS & Check if Status is in our Target Downstream Stages
  if (!slackThreadTs || !isValidThreadTs(slackThreadTs) || !pocStatus) {
    return;
  }

  const matchedStage = NOTIFIABLE_STATUSES.find((stage) =>
    pocStatus.toLowerCase().includes(stage.toLowerCase())
  );
  if (!matchedStage) {
    return; // Skip upstream stages handled by Slack Workflow Builder
  }

  // 4. Deduplicate Transition
  const dedupKey = `${taskGid}:${pocStatus.toLowerCase()}`;
  const now = Date.now();
  const lastProcessed = processedTransitions.get(dedupKey);
  if (lastProcessed && now - lastProcessed < DEDUP_TTL_MS) {
    return; // Already notified within the last 60s
  }
  processedTransitions.set(dedupKey, now);

  // 5. Build Status Message
  let statusIcon = '⚙️';
  let detailLine = '';

  if (pocStatus.toLowerCase().includes('provisioning') || pocStatus.toLowerCase().includes('active')) {
    statusIcon = '⚡';
    detailLine = `\n_TES team has picked up the request for *${customer}*. Environment sandbox is currently being provisioned._`;
  } else if (pocStatus.toLowerCase().includes('live') || pocStatus.toLowerCase().includes('implemented')) {
    statusIcon = '🟢';
    detailLine = `\n🎉 _The POC environment for *${customer}* is now live! Secure credentials have been delivered via Slack DM._`;
  } else if (pocStatus.toLowerCase().includes('completed')) {
    statusIcon = '🏁';
    detailLine = `\n_The POC engagement for *${customer}* has been finalized. Environment is scheduled for clean tear-down._`;
  } else if (pocStatus.toLowerCase().includes('rejected')) {
    statusIcon = '❌';
    detailLine = `\n_This POC request for *${customer}* has been closed/rejected._`;
  }

  const slackText = `${statusIcon} *Status Update: \`${sanitizeSlackText(pocStatus)}\`*${detailLine}`;

  // 6. Post Threaded Reply to Slack
  const slackRes = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: targetChannel,
      thread_ts: slackThreadTs,
      text: slackText
    },
    {
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      timeout: 5000
    }
  );

  console.log(
    JSON.stringify({
      event: 'slack_thread_status_posted',
      taskGid,
      pocStatus,
      slackThreadTs,
      slackOk: slackRes.data?.ok
    })
  );
}
```

### `src/routes/asanaWebhookHandler.ts`
```typescript
import { Request, Response } from 'express'; // Or Next.js / Amplify API handler equivalent
import { verifyAsanaSignature } from '../utils/security';
import { processAsanaTaskUpdate } from '../services/asanaSlackSync';

export async function asanaPocWebhookHandler(req: Request, res: Response) {
  try {
    // 1. Handle Asana Initial Webhook Handshake
    const hookSecretHeader = req.headers['x-hook-secret'] as string | undefined;
    if (hookSecretHeader) {
      res.setHeader('X-Hook-Secret', hookSecretHeader);
      return res.status(200).send();
    }

    // 2. Verify HMAC-SHA256 Signature on Event Payloads
    const signature = req.headers['x-hook-signature'] as string | undefined;
    const webhookSecret = process.env.ASANA_WEBHOOK_SECRET || '';
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    if (!verifyAsanaSignature(rawBody, signature, webhookSecret)) {
      console.warn(JSON.stringify({ event: 'unauthorized_webhook_signature' }));
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 3. Acknowledge Receipt Immediately to Asana
    res.status(200).json({ received: true });

    // 4. Extract Unique Task GIDs from Changed Events
    const events: Array<{
      resource?: { gid?: string; resource_type?: string };
      parent?: { resource_type?: string };
      action?: string;
    }> = req.body?.events || [];

    const taskGids = new Set<string>();
    for (const ev of events) {
      if (ev.resource?.resource_type === 'task' && ev.action === 'changed' && ev.resource.gid) {
        taskGids.add(ev.resource.gid);
      }
    }

    // 5. Process Each Task Asynchronously
    for (const gid of taskGids) {
      await processAsanaTaskUpdate(gid);
    }
  } catch (err: any) {
    console.error(JSON.stringify({ event: 'webhook_handler_error', message: err?.message }));
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}
```

---

## 7. Instructions for Cursor AI
When implementing this specification into the existing **AgentForge** repository:
1. Inspect our existing project structure (e.g., Next.js API routes, Express, or AWS Lambda handlers) and adapt `asanaPocWebhookHandler` to match our framework's routing and raw body parsing conventions.
2. Check if an Asana webhook handler already exists in the codebase; if so, extend the existing handler rather than duplicating the route.
3. Add unit tests verifying:
   - `X-Hook-Secret` handshake response.
   - `verifyAsanaSignature` rejection on invalid HMAC signatures.
   - Filtering out upstream statuses (`New Requests`, `Pending ATS Approval`, etc.) while allowing `Active Provisioning`, `Implemented / Live`, and `Completed`.
   - Deduplication when multiple `changed` events arrive for the same task and status within 60 seconds.
