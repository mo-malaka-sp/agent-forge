# SAF Test Drive Requests: Technical Architecture & System Specification

| | |
| :--- | :--- |
| **Document version** | 1.1 |
| **Fulfillment notes contract** | v1 (with end marker) |
| **Test project** | `Test Drive Requests - Testing` |
| **Target production project** | `Test Drive Requests` |
| **SailPoint tenant** | `beta-25503` (`https://beta-25503.identitynow-demo.com`) |

## 1. Executive Summary & Objective

The **SAF Test Drive Requests** automation pipeline is a cross-platform enterprise integration connecting **Slack**, **Asana**, **AgentForge (Backend Provisioning)**, and **Microsoft Power Automate**. 

Its primary business objective is to streamline the intake, governance, provisioning, and delivery of temporary, read-only demo environments (tenants) for SailPoint's Secure Agent Framework (SAF) / Entro product lines for Go-To-Market (GTM) teams, Solutions Engineering, and Partners.

### Core Architectural Guarantees
* **Private Slack Delivery:** Sensitive credentials (sandbox account, initial code, tenant link) are never posted to public or shared Slack channels; they are dispatched strictly via private 1-on-1 Slack Direct Messages (DMs). They are, however, stored in the Asana task (see [Section 8](#8-enterprise-security-governance--policy-workarounds)).
* **Short-Lived Credential:** The initial credential is a one-time 6-digit reset code that expires 60 minutes after it is issued, not a reusable password.
* **Notes Before Completion:** AgentForge always writes the fulfillment block to the task notes *before* it changes the task status. Power Automate therefore never sees a completed task without its block.
* **One Block Per Task:** A task holds at most one fulfillment block. A retry or a failure replaces the existing block instead of adding a second one.
* **Standard Licensing Compliance:** Operates completely on Microsoft Power Automate Standard connectors (Office 365 / Slack Standard), requiring zero Premium licenses, custom HTTP webhooks, or third-party middleware (e.g., Zapier/Workato).
* **Zero Custom Slack App / Bot Overhead:** Leverages pre-approved enterprise connectors and native Slack Workflow Builder features, avoiding unapproved custom `xoxb-` bot token dependencies.
* **Resilient Data Contracts:** Each fulfillment value sits on its own line between a start and an end marker, so parsing does not depend on what else is in the notes.
* **Three-State Dispatch:** The flow reads the status as `APPROVED`, `DECLINED`, or `NO_BLOCK`. A missing block, or a Slack User ID that does not start with `U`, stops the run. No DM is sent.

---

## 2. End-to-End System Architecture

```mermaid
flowchart TD
    subgraph Slack ["Slack (System of Intake & Engagement)"]
        A[User clicks 'Request SAF Test Drive' Button in #saf-testdrive-requests] --> B[Slack Workflow Intake Form Pops Up]
        B --> C[Form Submitted: Captures Metadata & User ID]
        C --> D[Post Confirmation Receipt to #saf-testdrive-requests]
        C --> E[Create Task in Asana 'Test Drive Requests - Testing']
    end

    subgraph Asana ["Asana (System of Record & Workflow Engine)"]
        E --> F[Rule 1: Set Custom Task Type to 'Work request' & Status to 'New request']
        F --> G[Rules 2-4: Map Dropdowns: MNDA, Partner/Direct, Request Type]
        G --> H[Asana Custom Script: Parse Text into Custom Fields: Customer, SFDC Link, Submitter]
    end

    subgraph AgentForge ["AgentForge (Backend Identity Provisioning)"]
        F -.->|Signed Asana webhook: status = New request| I[Set status 'Evaluation' & write 'Sandbox account']
        I --> I2[Create TestDriveUsers account, assign ReadOnly-Admins, issue 6-digit code]
        I2 -->|Success| J1[Write fields + notes block 'STATUS: APPROVED']
        I2 -->|Failure| J2[Write notes block 'STATUS: DECLINED' + post task comment]
        J1 --> K1[Set status 'Implemented' & 'Test Drive Status' = Done]
        J2 --> K2[Set status 'Declined']
    end

    K1 --> K[Asana marks the task complete: Implemented / Declined are completion statuses]
    K2 --> K

    subgraph PowerAutomate ["Power Automate (Standard License Dispatcher)"]
        K --> L[Trigger: When a task is completed V2]
        L --> M[Get task by ID V2 and Html to text]
        M --> N[Six variables parsed from the converted notes]
        N --> O{Gatekeeper: ID starts with U and status is recognized?}
        O -->|NO_BLOCK or ID is INVALID| R[Stop the run or alert the admin channel. No DM]
        O -->|DECLINED| P[Send Decline Notice DM to Requester in Slack]
        O -->|APPROVED| Q[Send Secure Credentials DM to Requester in Slack]
    end
```

> **Important:** AgentForge does **not** set `completed: true` itself. Asana marks the task complete because `Implemented` and `Declined` are configured as completion statuses on the `Work request` task type. If that setting is missing, the Power Automate trigger never fires. This is item 2 of the [cutover checklist](#12-production-cutover--go-live-checklist).

### 2.1 Task Status Lifecycle

| Asana `Work request` status | Set by | What is written | Notes block | Slack message |
| :--- | :--- | :--- | :--- | :--- |
| `New request` | Asana Rule 1 | Task type, dropdown fields, parsed text fields | — | Public receipt in `#saf-testdrive-requests` |
| `Evaluation` | AgentForge | `Sandbox account` (written immediately so a run can resume) | — | — |
| `Implemented` (+ `Test Drive Status` = `Done`) | AgentForge | `Sandbox account`, `Initial password`, tenant link field | `STATUS: APPROVED` | Credentials DM |
| `Declined` | AgentForge | Task comment with the reason | `STATUS: DECLINED` | Decline DM |
| `Needs information` / `Approved` | People only | — | — | — |

`STATUS: APPROVED` in the notes corresponds to the Asana status **Implemented**. AgentForge never sets the Asana status **Approved**.

### 2.2 Sequence

```mermaid
sequenceDiagram
    participant U as Requester (Slack)
    participant S as Slack Workflow
    participant A as Asana
    participant F as AgentForge
    participant P as SailPoint ISC (beta-25503)
    participant M as Power Automate

    U->>S: Submit form
    S->>A: Create task (notes template)
    S->>U: Public receipt in channel
    A->>A: Rules 1-4 + parser script
    A-->>F: Webhook event (status = New request)
    F->>A: Status = Evaluation, Sandbox account = name
    F->>P: Create account, assign ReadOnly-Admins, invite
    F->>P: Generate 6-digit reset code (60 min)
    alt Success
        F->>A: Fields + notes block (STATUS: APPROVED)
        F->>A: Status = Implemented, Test Drive Status = Done
    else Failure
        F->>A: Notes block (STATUS: DECLINED)
        F->>A: Comment with reason
        F->>A: Status = Declined
    end
    A->>A: Task marked complete
    M->>A: Trigger: task completed, get task
    M->>U: Private DM (credentials or decline)
```

---

## 3. Component Breakdown & Responsibilities

| Component | Role | Trigger / Method | Key Artifacts / IDs | Owner |
| :--- | :--- | :--- | :--- | :--- |
| **Slack Intake Workflow** | Entry point, intake validation, public receipt | Link / Shortcut trigger (`https://slack.com/shortcuts/...`) | Channel `#saf-testdrive-requests` (`C0CFXQTLT6Y`), Workflow Icon: Cyber Shield | _TBD_ |
| **Asana Project Board** | Central system of record, operational tracking | Native Asana Rules & Scripting | Project: `Test Drive Requests - Testing` (Target Prod: `Test Drive Requests`) | _TBD_ |
| **Asana Automation Rules** | Structural state setup & dropdown mapping | `Task added to project` | Custom Task Type: `Work request`, Status: `New request` | _TBD_ |
| **Asana Script (`run()`)** | Dynamic regex metadata parser | `Task added to project` | node-asana v3 SDK parameter sequence | _TBD_ |
| **AgentForge** | Sandbox account provisioning on the SailPoint tenant | Signed Asana project webhook on status `New request` (page poll as fallback) | Writes fields and the `--- FULFILLMENT DETAILS ---` block, then sets `Implemented` or `Declined` | _TBD_ |
| **Power Automate Flow** | Gatekeeper and private DM dispatcher | `When a task is completed (V2)` | Flow: `SAF - Fulfillment Thread Reply & DM` | _TBD_ |

---

## 4. Slack Workflow Builder Configuration

* **Workflow Name:** `SAF Test Drive Requests`
* **Trigger:** **Starts from a link in Slack** (`https://slack.com/shortcuts/Ft0CFCS1JXHV/61952`)
* **Trigger Placement:** Pinned inside `#saf-testdrive-requests` (`C0CFXQTLT6Y`) on the **Channel Canvas** and the **Bookmark Bar** as an action button: `🟢 Request SAF Test Drive`.

### Step 1: Collect info in a form
* **Title:** `SAF Test Drive Request`
* **Target:** `Person who clicked the link`
* **Form Fields:**
  1. `Customer` (Short Text, Required) — Full company name as listed in SFDC.
  2. `Customer Email Address(es)` (Short Text, Required) — Comma-separated admin emails (Max 3).
  3. `Link to SFDC Opportunity` (Short Text, Required) — SFDC Opportunity URL.
  4. `Is this Test Drive for a customer directly or through a partner?` (Dropdown: `Customer`, `Partner`)
  5. `Has a SailPoint MNDA or Eval Agreement been signed?` (Dropdown: `Yes`, `No`)
  6. `Is this a net-new provisioning request, or an extension request for an existing Test Drive?` (Dropdown: `New request`, `Extension`)

### Step 2: Create a task (Asana Integration)
* **Workspace:** `SailPoint Technologies`
* **Project:** `Test Drive Requests - Testing` (Move to production upon cutover)
* **Task Name:** `SAF Test Drive Request - {Answer to: Customer}`
* **Description Template (`notes`):**
```text
A new SAF Test Drive Request has been submitted!

Requester: {Person who used this workflow}
Prospect/Customer: {Answer to: Customer}
Main Contact Email(s): {Answer to: Customer Email Address(es)}
SFDC Opportunity Link: {Answer to: Link to SFDC Opportunity}
Test Drive Type: {Answer to: Is this Test Drive for a customer directly or through a partner?}
MNDA Signed?: {Answer to: Has a SailPoint MNDA or Eval Agreement been signed?}
Request Type: {Answer to: Is this a net-new provisioning request, or an extension request for an existing Test Drive?}

Slack User ID: {Person who used this workflow (User ID)}

This task was submitted through SailPoint SAF Test Drive Request.
```

### Step 3: Send a message to a channel
* **Channel:** `#saf-testdrive-requests` (`C0CFXQTLT6Y`)
* **Message Text:**
```text
🎉 *SAF Test Drive Request Submitted!*
Thank you <@{Person who used this workflow}>. Your request has been logged in Asana and provisioning has started.

🔒 *Next Steps:* Once your test drive environment is ready, your credentials, account, and tenant link will be sent directly to your *Direct Messages (DMs)* for security.

*Request Details:*
• *Customer:* {Answer to: Customer}
• *MNDA Signed?:* {Answer to: Has a SailPoint MNDA or Eval Agreement been signed?}
• *Type:* {Answer to: Is this a net-new provisioning request, or an extension request for an existing Test Drive?}
```

---

## 5. Asana Workflow Architecture & Custom Scripting

To convert incoming tasks into the custom `Work request` task type and stamp custom fields without premium middleware, Asana uses a combination of native rules and a custom JavaScript automation.

### Asana Native Visual Rules
* **Rule 1 (`SAF - Initialize Work Request Status`):**
  * *Trigger:* `Task added to this project`
  * *Actions:* `Change task type` ➔ `Work request` THEN `Set Work request status` ➔ `New request`.
* **Rule 2 (`SAF - Map MNDA Signed Status`):**
  * *Trigger:* `Task added to this project`
  * *Branch 1:* Description contains `MNDA Signed?: Yes` ➔ Set `MDNA signed?` = `Yes`
  * *Branch 2:* Description contains `MNDA Signed?: No` ➔ Set `MDNA signed?` = `No`
* **Rule 3 (`SAF - Map Partner or Direct`):**
  * *Trigger:* `Task added to this project`
  * *Branch 1:* Description contains `Test Drive Type: Customer` ➔ Set `Test Drive Partner or Direct` = `Customer`
  * *Branch 2:* Description contains `Test Drive Type: Partner` ➔ Set `Test Drive Partner or Direct` = `Partner`
* **Rule 4 (`SAF - Map New or Extension`):**
  * *Trigger:* `Task added to this project`
  * *Branch 1:* Description contains `Request Type: New request` ➔ Set `New or extension` = `New request`
  * *Branch 2:* Description contains `Request Type: Extension` ➔ Set `New or extension` = `Extension`

### Asana Custom Script: Metadata Parser
* **Rule Name:** `SAF - Parse Slack Metadata & Populate Fields`
* **Trigger:** `Task added to this project`
* **Action:** `Run script`
* **Runtime:** Node.js (node-asana v3 SDK)

```javascript
/**
 * SAF - Parse Slack Metadata & Populate Fields
 * Uses node-asana v3 parameter order: updateTask(body, target_gid)
 */
async function run() {
  if (target_type === "Task") {
    // 1. Retrieve full task details (including notes and custom_fields)
    const task = await tasksApiInstance.getTask(target_gid);
    const description = task.data.notes || "";

    log("Successfully retrieved task notes. Beginning metadata extraction...");

    // 2. Parse values from the description lines
    const requesterRegex = /Request[eo]r:\s*(.+)/i;
    const customerRegex = /Prospect\/Customer:\s*(.+)/i;
    const emailRegex = /Main Contact Email\(s\):\s*(.+)/i;
    const sfdcRegex = /SFDC Opportunity Link:\s*(.+)/i;

    const parsedRequester = (description.match(requesterRegex)?.[1] || "").trim();
    const parsedCustomer = (description.match(customerRegex)?.[1] || "").trim();
    const parsedEmail = (description.match(emailRegex)?.[1] || "").trim();
    const parsedSFDCLink = (description.match(sfdcRegex)?.[1] || "").trim();

    // 3. Dynamically match custom field GIDs by name
    const customFieldsPayload = {};
    const taskCustomFields = task.data.custom_fields || [];

    const findFieldGidByName = (name) => {
      const field = taskCustomFields.find(
        (f) => f.name && f.name.trim().toLowerCase() === name.trim().toLowerCase()
      );
      return field ? field.gid : null;
    };

    const submitterGid = findFieldGidByName("Submitter Name");
    const customerGid = findFieldGidByName("Customer/Partner/Event");
    const emailGid = findFieldGidByName("Main Contact Email");
    const sfdcGid = findFieldGidByName("SFDC Link");

    if (submitterGid && parsedRequester) customFieldsPayload[submitterGid] = parsedRequester;
    if (customerGid && parsedCustomer) customFieldsPayload[customerGid] = parsedCustomer;
    if (emailGid && parsedEmail) customFieldsPayload[emailGid] = parsedEmail;
    if (sfdcGid && parsedSFDCLink) customFieldsPayload[sfdcGid] = parsedSFDCLink;

    // 4. Update the task with payload FIRST, target_gid SECOND (node-asana v3)
    if (Object.keys(customFieldsPayload).length > 0) {
      log("Updating custom fields payload: " + JSON.stringify(customFieldsPayload));

      await tasksApiInstance.updateTask(
        {
          data: {
            custom_fields: customFieldsPayload,
          },
        },
        target_gid
      );

      log("Successfully updated all custom text fields in Asana!");
    } else {
      log("No matching custom fields or parsed values found. Skipping update.");
    }
  }
}

run();
```

---

## 6. AgentForge Provisioning & Fulfillment Contract

### 6.1 Detection
* **Primary:** an Asana webhook on the project. Asana signs every event and AgentForge verifies the signature before acting. The webhook is registered when **Save and connect** is pressed in the AgentForge back desk.
* **Fallback:** while the AgentForge page is open, it polls every 4 seconds to finish accounts that are still activating. The full lookup of tenant accounts runs at most every 5 minutes.
* **Trigger condition:** the task's `Work request` status is `New request`. AgentForge does not read the `MDNA signed?` or `New or extension` fields (see [Section 13](#13-known-gaps--open-items)).

### 6.2 What AgentForge creates in SailPoint

| Item | Value |
| :--- | :--- |
| Tenant | `beta-25503` |
| Source | `TestDriveUsers` (account type `TestDrive`) |
| Username | Random `first.last@testmail.identitysoon.com`. It is not derived from the customer name. |
| Access | Role `ReadOnly-Admins`, granted automatically to `TestDrive` accounts; it grants the `SAF Admin` entitlement on the `IdentityNow` source |
| Lifecycle | Identity set to active, invitation sent |
| Initial credential | 6-digit helpdesk reset code, valid for **60 minutes** (longer durations are tracked in ISCARP-20309) |

### 6.3 Order of writes to Asana
1. Status → `Evaluation`, and the `Sandbox account` field is written straight away. A run that stops part-way can resume from this field instead of creating a second account.
2. **Success:** the `Sandbox account`, `Initial password` and tenant link fields, plus the notes block, are written in **one** update. Only after that does a second update set the status to `Implemented` and `Test Drive Status` to `Done`.
3. **Failure:** the `STATUS: DECLINED` notes block is written, then a task comment with the same reason is posted, then the status is set to `Declined`. A task that is already `Implemented` is never declined.

The tenant link field is configurable in the back desk; the test project currently uses `Customer role`.

### 6.4 Notes contract (v1)

The block is always at the bottom of the notes, starts with `--- FULFILLMENT DETAILS ---`, ends with `--- END FULFILLMENT DETAILS ---`, and holds one `KEY: value` per line. When AgentForge writes a new block it removes any earlier one first. Text that someone adds below an end marker is kept above the new block.

#### Contract Schema A: Provisioning Success (Approved)
```text
--- FULFILLMENT DETAILS ---
STATUS: APPROVED
TENANT_LINK: https://beta-25503.identitynow-demo.com
SANDBOX_ACCOUNT: jade.ortiz@testmail.identitysoon.com
INITIAL_PASSWORD: 008604
--- END FULFILLMENT DETAILS ---
```

#### Contract Schema B: Provisioning Failure (Declined)
```text
--- FULFILLMENT DETAILS ---
STATUS: DECLINED
REASON: SailPoint API returned HTTP 503 for POST /accounts/v1. Tenant unavailable.
--- END FULFILLMENT DETAILS ---
```

`REASON` is always a single line. Blocks written before the end marker was introduced have no end marker and run to the end of the notes; AgentForge still replaces them correctly.

**Contract rules:** keys, their order, and the uppercase `STATUS` values are a contract with the Power Automate flow. Any change must bump the contract version at the top of this document and be released together with the flow update.

### 6.5 Back desk configuration
The back desk (AgentForge → Read-only account panel) holds the settings AgentForge needs. They are stored in DynamoDB, so they survive deploys and are shared by every server.

| Setting | Purpose |
| :--- | :--- |
| Asana access token | Reads and updates tasks, registers the webhook |
| SailPoint tenant, client ID, client secret | Calls the tenant APIs |
| Project name | `Test Drive Requests - Testing` → production `Test Drive Requests` |
| Statuses | Trigger `New request`, working `Evaluation`, done `Implemented`, declined `Declined` |
| Fields | `Sandbox account`, `Initial password`, tenant link field |
| Tenant link template | `https://{tenant}.identitynow-demo.com` |

Hosting requirements (Amplify):
* `SAF_POC_TABLE_NAME` is set, and the compute role (`AMPLIFY_COMPUTE_ROLE_NAME`) can read and write that table.
* Without the table, **Save and connect** refuses to save on a deployed server, because a file on the server is erased on every deploy.
* The panel shows where the desk is stored after each save. If the desk cannot be read, AgentForge leaves tasks untouched instead of declining them.

---

## 7. Power Automate Workflow Specification

* **Flow Name:** `SAF - Fulfillment Thread Reply & DM`
* **Trigger:** `Asana - When a task is completed (V2)`
  * *Workspace:* `SailPoint Technologies`
  * *Project:* `Test Drive Requests - Testing`
* **Action 1:** `Asana - Get task by ID (V2)`
  * *Task ID:* `@{triggerOutputs()?['body/gid']}`
* **Action 2:** `Content Conversion - Html to text`
  * *Content:* `@{outputs('Get_task_by_ID_(V2)')?['body/notes']}`

The expressions below read `outputs('Html_to_text')?['body']`. `varSlackUserId` splits on a line break (`decodeUriComponent('%0A')`), so that step must keep line breaks. The credential and reason values are bounded by the next key or by `--- END FULFILLMENT DETAILS ---`, so text typed after the block cannot leak into a DM.

The expressions search the whole converted notes. AgentForge keeps a single block, which makes the keys unique. The words `STATUS: APPROVED` typed above the block would be read as the status.

### Root-Level Variable Declarations (Sequential Stack)

> **Platform Rule:** In Power Automate, all `Initialize variable` actions MUST be declared at the root level of the flow. They cannot be nested inside Conditions.

#### 1. `varSlackUserId` (Type: `String`)
The ID is taken from the first line after `Slack User ID:`, then the first word of that line. A missing line resolves to `INVALID`. There is no default person.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'Slack User ID:'),
  trim(first(split(trim(first(split(last(split(outputs('Html_to_text')?['body'], 'Slack User ID:')), decodeUriComponent('%0A')))), ' '))),
  'INVALID'
)
```

#### 2. `varStatus` (Type: `String`)
`APPROVED`, `DECLINED`, or `NO_BLOCK`. A task completed by hand, with no fulfillment block, returns `NO_BLOCK`.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'STATUS: DECLINED'),
  'DECLINED',
  if(
    contains(outputs('Html_to_text')?['body'], 'STATUS: APPROVED'),
    'APPROVED',
    'NO_BLOCK'
  )
)
```

#### 3. `varDeclineReason` (Type: `String`)
Read from `REASON:` up to `--- END FULFILLMENT DETAILS ---`.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'REASON:'),
  trim(first(split(last(split(outputs('Html_to_text')?['body'], 'REASON:')), '--- END FULFILLMENT DETAILS ---'))),
  'No specific reason provided.'
)
```

#### 4. `varTenantLink` (Type: `String`)
Read from `TENANT_LINK:` up to `SANDBOX_ACCOUNT:`.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'TENANT_LINK:'),
  trim(first(split(last(split(outputs('Html_to_text')?['body'], 'TENANT_LINK:')), 'SANDBOX_ACCOUNT:'))),
  ''
)
```

#### 5. `varSandboxAccount` (Type: `String`)
Read from `SANDBOX_ACCOUNT:` up to `INITIAL_PASSWORD:`.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'SANDBOX_ACCOUNT:'),
  trim(first(split(last(split(outputs('Html_to_text')?['body'], 'SANDBOX_ACCOUNT:')), 'INITIAL_PASSWORD:'))),
  ''
)
```

#### 6. `varInitialPassword` (Type: `String`)
Read from `INITIAL_PASSWORD:` up to `--- END FULFILLMENT DETAILS ---`.

```text
if(
  contains(outputs('Html_to_text')?['body'], 'INITIAL_PASSWORD:'),
  trim(first(split(last(split(outputs('Html_to_text')?['body'], 'INITIAL_PASSWORD:')), '--- END FULFILLMENT DETAILS ---'))),
  ''
)
```

### Condition & Branching Logic

**Condition 1, the gatekeeper.** All three must be true:

* `variables('varSlackUserId')` is not equal to `INVALID`
* `variables('varSlackUserId')` starts with `U`
* `variables('varStatus')` is not equal to `NO_BLOCK`

The gatekeeper does not check that the account or the password is non-empty. An `APPROVED` block with either value missing still sends the DM.

* **False.** No DM is sent. The run terminates (`Succeeded` or `Cancelled`), or it posts this diagnostic to an admin channel such as `#saf-testdrive-alerts`. The channel is not chosen yet (see [Section 13](#13-known-gaps--open-items)).
  ```text
  ⚠️ *SAF Test Drive Dispatch Skipped:* Task @{triggerOutputs()?['body/gid']} was completed without a valid fulfillment block or with an unparseable Slack User ID.
  ```
  This covers a task completed by hand, a task declined by a person with no block, and a request whose Slack User ID cannot be read.
* **True.** Continue to Condition 2.

**Condition 2.** `variables('varStatus')` is equal to `DECLINED`.

#### True: `DECLINED`
* **Action:** `Slack - Post message (V2)`
  * *Channel Name (Enter custom value):* `@{variables('varSlackUserId')}` *(Routes natively as a private DM)*
  * *Message Text:*
```text
⚠️ *SAF Test Drive Request Update*

Hi <@{variables('varSlackUserId')}>,

Your SAF Test Drive request could not be completed at this time.

• *Status:* ❌ *DECLINED*
• *Reason:* @{variables('varDeclineReason')}

👉 *Next Steps:* Please follow up with the team in *#saf-testdrive-requests* if you need assistance or believe this was declined in error.
```

#### False: `APPROVED`
* **Action:** `Slack - Post message (V2)`
  * *Channel Name (Enter custom value):* `@{variables('varSlackUserId')}`
  * *Message Text:*
```text
🎉 *Your SAF Test Drive Environment is Ready!*

Hi <@{variables('varSlackUserId')}>,

Your SAF Test Drive environment has been provisioned. Here are your credentials:

🔗 *Tenant Link:* @{variables('varTenantLink')}
👤 *Sandbox Account:* `@{variables('varSandboxAccount')}`
🔑 *Initial Password:* `@{variables('varInitialPassword')}`

🔒 *Security Notice:* Please sign in and reset your credentials promptly. Do not share these credentials in public channels.
```

> **Duplicate messages:** if a task is reopened and completed again, the trigger fires again and the requester receives a second DM. That is expected after a retry (see [Section 10](#10-runbook--observability)).

---

## 8. Enterprise Security, Governance, & Policy Workarounds

| Enterprise Constraint | Technical Impact | Architectural Solution / Workaround |
| :--- | :--- | :--- |
| **No Slack Bot Tokens (`xoxb-`)** | Direct Asana-to-Slack `fetch()` calls blocked | Power Automate standard Slack connector runs under authorized corporate user context. DMs therefore come from that named user. |
| **No Slack Channel Read / History in Power Automate** | Power Automate cannot read channels or resolve thread timestamps | Eliminated thread dependency. Form captures raw `Slack User ID`, and Power Automate DMs the user directly. |
| **Slack DM Action Blocked in Power Automate** | Standard `Post DM` step unavailable | Trick: Pass raw `Slack User ID` (e.g., `U0AUACHKTDF`) into the `Channel Name` parameter of `Post message (V2)`. |
| **No Premium Microsoft Licenses** | Custom HTTP Webhook triggers and actions locked | Replaced webhook trigger with native `When a task is completed (V2)` trigger on Asana. |
| **Missing Custom Fields in Asana API** | `Get task by ID (V2)` omits custom fields by default | Description notes (`notes`) hold the fulfillment payload. Power Automate parses notes directly using regex-free string splits between start and end markers. |
| **Variable Initialization Nesting Error** | Flow save fails if variables are placed inside Condition | All 6 variables are initialized at the top level with `if(contains(...))` fallback safety checks. |
| **Unintended Manual Task Completion** | Completing a task by hand sent an approval DM full of empty values | `varStatus` returns `NO_BLOCK` unless the notes contain `STATUS: APPROVED` or `STATUS: DECLINED`, and the gatekeeper stops the run. |
| **Trailing Description Bleed** | Text typed after the password was included in the DM | `varInitialPassword` and `varDeclineReason` stop at `--- END FULFILLMENT DETAILS ---`. |
| **Retry Dual-Block Contamination** | A retried task kept the old block under the new one, so the flow could read mixed values | AgentForge removes the existing fulfillment block before writing the new one. A task holds one block. |

### 8.1 Where credentials live

| Location | Contents | Who can see it |
| :--- | :--- | :--- |
| Asana task notes | Account, one-time code, tenant link | Every project member, plus the task's change history |
| Asana fields `Sandbox account` / `Initial password` | Account, one-time code | Every project member |
| Slack DM | Account, one-time code, tenant link | The requester only |
| AgentForge back desk (DynamoDB) | Asana token, SailPoint client secret | AWS account administrators |

Mitigations:
* The code is single-use and expires after 60 minutes, which limits the exposure in Asana.
* Keep the Asana project private to the fulfillment team.
* _Optional:_ after the DM is sent, have the flow clear `INITIAL_PASSWORD` from the notes with `Asana - Update task`.
* A missing or unreadable Slack User ID becomes `INVALID`, and the gatekeeper sends no DM. There is no hard-coded default user.

---

## 9. Failure Catalog

Every failure produces a `STATUS: DECLINED` block, a task comment with the same reason, the status `Declined`, and a decline DM, unless noted.

| Failure | What the reason says | Likely cause | Action |
| :--- | :--- | :--- | :--- |
| SailPoint unavailable | `SailPoint API returned HTTP 503 for <request>…` | Tenant down or in maintenance | Wait, then retry (Section 10) |
| Cloudflare block | `Cloudflare blocked the request (error <code>, Ray ID <id>). This is a network block in front of the tenant…` | WAF rule in front of the tenant | Send the error code and Ray ID to the tenant/network owners |
| Reset code refused | `Reset code was not issued. SailPoint API returned HTTP 403 for POST /v2025/generate-password-reset-token/digit…` | Digit token reset disabled, or client lacks scope | Fix tenant config or client scopes, then retry |
| Account never activates | Status stays `Evaluation` | Tenant aggregation is slow | AgentForge keeps checking; investigate if it stays longer than the agreed limit (_TBD_) |
| Back desk missing or unreadable | **Task is left unchanged** (not declined) | Desk not saved after a deploy, or DynamoDB unreachable | Open the back desk, **Save and connect** |
| Asana update fails | Reason names the Asana call and HTTP status | Expired token, field renamed, missing permission | Fix the token or field names in the back desk |
| No Slack User ID / no block | No DM. The run terminates, or an admin notice is posted | Form changed, or task completed by hand | `varStatus` is `NO_BLOCK` or `varSlackUserId` is `INVALID`. Contact the requester directly |

---

## 10. Runbook & Observability

### Where to look
* **Asana task:** the status, the comments (failure reasons), the notes block, and the activity history.
* **AgentForge:** the webhook log in the read-only account panel shows every event received and what was done with it. The panel also shows where the back desk is stored.
* **Power Automate:** the run history of `SAF - Fulfillment Thread Reply & DM` shows each variable's parsed value.

### Retry a declined request
1. Fix the cause listed in the reason.
2. Reopen the task (mark it incomplete), then set the `Work request` status back to `New request`.
3. AgentForge creates a **new** sandbox account and replaces the notes block; the requester receives a new DM. The account from the earlier attempt, if any, stays in the tenant and must be removed by hand.

### Re-issue an expired code
_TBD:_ AgentForge has no separate "new code" action today. The current workaround is the retry above, which also creates a new account.

---

## 11. E2E Test Plan

Run these in `Test Drive Requests - Testing` before cutover and after any change to the form, rules, AgentForge, or the flow.

| # | Scenario | Setup | Expected in Asana | Expected in Slack |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Happy path | Valid form | `Evaluation` → `Implemented`, `Test Drive Status` = `Done`, fields filled, `STATUS: APPROVED` block, task complete | Receipt in channel + credentials DM; code works within 60 minutes |
| 2 | SailPoint down | Tenant unavailable | `STATUS: DECLINED` with an HTTP 5xx reason, comment, `Declined` | Decline DM with the same reason |
| 3 | Cloudflare block | Request blocked at the edge | Reason includes error code and Ray ID | Decline DM |
| 4 | Back desk missing | Deploy without saving the desk | Task stays `New request`, nothing written | No DM |
| 5 | Retry after decline | Scenario 2, then follow the retry steps | Exactly one block in the notes, `STATUS: APPROVED` | Second DM with credentials |
| 6 | Manual completion | Mark a `New request` task complete by hand | No block | `varStatus` = `NO_BLOCK`. Run stops or admin notice. No DM |
| 7 | Missing Slack User ID | Remove the line from the notes before completion | — | `varSlackUserId` = `INVALID`. No credentials sent |
| 8 | Text after the block | Add a line below the end marker, then retry | New block at the bottom, the added line kept above it | DM values unaffected |
| 9 | Duplicate submission | Submit the same customer twice | Two tasks, two accounts | Two DMs |
| 10 | MNDA = No | Form with MNDA `No` | _Currently provisions anyway_ (see Section 13) | Credentials DM |
| 11 | Extension | Form with request type `Extension` | _Currently creates a new account_ (see Section 13) | Credentials DM |
| 12 | Bounds in the flow | Any approved task, plus one with a line typed under the end marker | — | Run history: password and reason stop at the end marker; tenant link and account stop at the next key |

---

## 12. Production Cutover & Go-Live Checklist

Follow these steps when moving from the sandbox environment to live production:

1. **Slack Workflow Builder:**
   * Open `SAF Test Drive Requests`.
   * Edit **Step 2 (Create a task):** Change project from `Test Drive Requests - Testing` to production project: `Test Drive Requests`.
   * Confirm the trigger link is shared in `#saf-testdrive-requests` via the Canvas button and Bookmark Bar.
2. **Production Asana Board Setup:**
   * Ensure the project has the custom task type `Work request` enabled with statuses: `New request`, `Needs information`, `Evaluation`, `Approved`, `Declined`, `Implemented`.
   * **Confirm that `Implemented` and `Declined` mark the task complete.** Without this, Power Automate never fires.
   * Create/verify custom fields: `Submitter Name`, `Customer/Partner/Event`, `Main Contact Email`, `SFDC Link`, `MDNA signed?`, `Test Drive Partner or Direct`, `New or extension`, `Sandbox account`, `Initial password`, `Test Drive Status` (with option `Done`), and the tenant link field (`Customer role` today, or a new `Tenant Link` field).
   * Replicate the **4 Native Rules** and the **Custom Script (`SAF - Parse Slack Metadata & Populate Fields`)**.
   * Keep the project private to the fulfillment team (Section 8.1).
3. **AgentForge Backend:**
   * Confirm `SAF_POC_TABLE_NAME` is set in Amplify and the compute role can use the table.
   * In the back desk, set the project name to `Test Drive Requests`, check the status and field names, and press **Save and connect**. The panel must report DynamoDB storage.
   * Confirm the webhook log shows events from the production project.
   * Verify the block is written with proper casing (`STATUS: APPROVED` or `STATUS: DECLINED`) and ends with `--- END FULFILLMENT DETAILS ---`.
4. **Power Automate Production Flow:**
   * In `SAF - Fulfillment Thread Reply & DM`, update the **Trigger** and **Get task by ID** steps to point to the production Asana workspace and project.
   * Confirm the six variables, the `Html to text` step, and the gatekeeper match Section 7. A failed gatekeeper must not send a DM.
   * Verify flow status is toggled to **On / Active**.
5. **Sign-off:** run E2E scenarios 1, 2, 5, 6 and 12 against production.

---

## 13. Known Gaps & Open Items

| Item | Impact | Proposal | Owner |
| :--- | :--- | :--- | :--- |
| MNDA is not enforced | Requests with MNDA `No` are provisioned | Asana rule: MNDA `No` → status `Needs information` (AgentForge only acts on `New request`), or have AgentForge decline it | _TBD_ |
| Extensions create new accounts | An extension request produces a second account instead of extending the first | Route `Extension` to `Needs information` until extension handling exists | _TBD_ |
| No account expiry | Sandbox accounts stay until removed by hand | Define a lifetime and a cleanup job | _TBD_ |
| No code re-issue | An expired code needs a full retry and a new account | Add a "new code" action in AgentForge | _TBD_ |
| Customer emails unused | `Main Contact Email` is captured but not used | Confirm whether customers should get accounts directly | _TBD_ |
| Tenant link stored in `Customer role` | Field name does not match its content | Create a `Tenant Link` field and update the back desk | _TBD_ |
| `MDNA signed?` field name | Typo in the Asana field name | Rename to `MNDA signed?` and update Rule 2 | _TBD_ |
| Code sign-in steps | The approved DM calls the value an initial password and says to sign in and reset it. It does not say the code expires after 60 minutes | Confirm the sign-in steps with the identity team and update the DM | _TBD_ |
| Admin notice channel | A failed gatekeeper can post a diagnostic. The channel is undecided; `#saf-testdrive-alerts` is only an example | Choose the channel, or confirm the run terminates with no post | _TBD_ |
