# AgentForge + SailPoint Identity Security Cloud

Connect AgentForge synthetic AI agents to Identity Security Cloud (ISC) using a **Web Services SaaS** source. No AWS, GCP, or Azure credentials are required.

**AgentForge demo URL:** `https://main.d12mzah9vzl24s.amplifyapp.com`  
**Setup guide on site:** `/setup`

---

## What this demo proves

| Concept | Meaning in AgentForge | Where to show it in ISC |
|---------|----------------------|-------------------------|
| **Outbound access** | What the agent can reach (`S3:Read`, `Jira:Admin`) | **AI Agent → Access** (`outboundPermissions`) |
| **Inbound access** | Who can invoke the agent (`invoke:engineering-team`) | **AI Agent → Access** (`inboundCallers`) |
| **Agent identity** | The governed AI agent | **Admin → Identities → AI Agents** |
| **Source account** | The connector account backing the agent | **Sources → Accounts** |
| **Provisioning** | ISC applies access changes back to AgentForge | **Access profiles / certifications → provisioning** |
| **Authorization** | Runtime allow/deny against effective access | **AgentForge authorize API + simulate panel** |
| **ISC orchestrator** | One-click sync and govern + enforce from AgentForge | **Dashboard → ISC demo orchestrator** |

**Primary demo screen:** **AI Agent → Access** (not Identity Graph). Identity Graph is optional; Web Services account entitlements often appear on the Access tab but not as expandable nodes on the agent-root graph.

After provisioning, re-run **account aggregation** so ISC reflects updated entitlements or disabled status. The **ISC demo orchestrator** can run aggregations and authorization steps for you — no Postman required.

---

## Recommended demo path (single Bedrock source)

Use **one Web Services source** per platform (e.g. `AI Agents Bedrock`). The hero agent `CloudOps-Navigator:Infra-DevOps-Agent` ships **~14 entitlements** on that single source — IAM policies, Google Workspace roles, AD groups, and classic outbound/inbound permissions are all modeled as `outboundPermissions` / `inboundCallers` on the Bedrock account payload.

| Check | Expected (AWS hero) |
|-------|---------------------|
| AI Agents list | **1** agent: `CloudOps-Navigator:Infra-DevOps-Agent` |
| AI Agent → Access | **~14** entitlements, all source `AI Agents Bedrock` |
| AI Agent → Accounts | **1** Bedrock account |
| Identity Graph | Blue entitlement leaves under one source; optional privilege rings after [Part M](#part-m--privilege-classification-identity-graph-colors) |

> No extra ISC sources are required. Deploy the latest AgentForge build, run [A0](#a0--load-hero-agents-phase-1--do-this-first) full-store reset, then re-aggregate your Bedrock source.

---

## Prerequisites

- AgentForge reachable from your ISC tenant
- Permission to create and configure sources in ISC
- **Agent Identity Security (AIS)** licensed on your tenant
- Create **one Web Services source per platform** you demo (e.g. AWS Bedrock)
- For the **ISC demo orchestrator**: API client credentials with source, account, entitlement, and machine-identity scopes (see [Part K](#part-k--isc-demo-orchestrator))

Verify AgentForge:

```bash
curl -s https://main.d12mzah9vzl24s.amplifyapp.com/api/health
```

---

## Part A — Prepare data in AgentForge

### A0 — Load hero agents (Phase 1 — do this first)

AgentForge ships three **hero agents** with rich metadata, linked accounts, and extended entitlements:

| Platform | Agent name | Agent ID |
|----------|------------|----------|
| AWS Bedrock | `CloudOps-Navigator:Infra-DevOps-Agent` | `agt_demo_aws_bedrock` |
| GCP Vertex | `sw-bug-assistant-25924` | `agt_demo_gcp_vertex` |
| Azure Foundry | `Frontline-Support-Bot` | `agt_demo_azure_foundry` |

**Reset to hero seed:**

1. Open AgentForge → **/demo**
2. Click **Reset demo agent**
3. Choose scope **full-store** (removes bulk agents, restores the 3 heroes)
4. Confirm the AWS hero name is `CloudOps-Navigator:Infra-DevOps-Agent`

Or via API:

```bash
curl -s -X POST https://https://main.d12mzah9vzl24s.amplifyapp.com/api/demo/reset \
  -H "Content-Type: application/json" \
  -d '{"scope":"full-store","remove_bulk_agents":true}'
```

**Verify locally:**

```bash
curl -s https://https://main.d12mzah9vzl24s.amplifyapp.com/api/agents/agt_demo_aws_bedrock | jq '.agent.name, (.agent.extended_entitlements | length), (.agent.linked_accounts | length)'
```

Expected: name `CloudOps-Navigator:Infra-DevOps-Agent`, **14** extended entitlements, **1** linked account.

### A1 — Bulk-create agents (optional)

**Option 1 — ISC demo orchestrator (recommended after one-time ISC setup):**

1. Configure ISC env vars on AgentForge (see [Part K](#part-k--isc-demo-orchestrator))
2. Open the dashboard → **ISC demo orchestrator** → **Run full sync**

This bulk-creates agents and runs ISC aggregations in order.

**Option 2 — Manual bulk create:**

1. Open the AgentForge dashboard
2. Use **Quick bulk create** — pick platform and **5, 10, or 20** agents
3. Each agent gets random **outbound** permissions and **inbound** callers

Or use the three hero seed agents on a fresh install (see [A0](#a0--load-hero-agents-phase-1--do-this-first)).

### A2 — Understand the payloads

**Accounts** (`GET /api/connectors/web-services/{platform}/accounts`):

| Field | Purpose |
|-------|---------|
| `accountId` | Short stable ID (`agt_xxx`) — map to Account ID |
| `nativeIdentity` | Cloud ARN / resource ID — **must match** machine identity Native Identity |
| `identityName` | Display name for machine identity aggregation |
| `outboundPermissions` | Outbound access (multi-valued) |
| `inboundCallers` | Inbound access (multi-valued) |

**Entitlements** (`GET /api/connectors/web-services/{platform}/entitlements`):

| Query | Purpose |
|-------|---------|
| (none) | All entitlements |
| `?type=outbound` | Outbound catalog only |
| `?type=inbound` | Inbound catalog only |

Root path for entitlements: `$.entitlements[*]`

### A3 — Endpoint reference

| Platform | Accounts | Entitlements |
|----------|----------|--------------|
| AWS Bedrock | `/api/connectors/web-services/aws-bedrock/accounts` | `/api/connectors/web-services/aws-bedrock/entitlements` |
| GCP Vertex | `/api/connectors/web-services/gcp-vertex/accounts` | `/api/connectors/web-services/gcp-vertex/entitlements` |
| Azure AI Foundry | `/api/connectors/web-services/azure-ai-foundry/accounts` | `/api/connectors/web-services/azure-ai-foundry/entitlements` |

**Sample account (hero AWS Bedrock):**

```json
{
  "accountId": "acct_aws_bedrock_primary",
  "name": "CloudOps-Navigator:LVA0UBIDXW",
  "nativeIdentity": "arn:aws:bedrock:us-west-2:718666815581:agent-alias/OBK4WA6JJN/LVA0UBIDXW",
  "identityName": "CloudOps-Navigator:Infra-DevOps-Agent",
  "machineIdentity": "CloudOps-Navigator:Infra-DevOps-Agent",
  "sourceName": "AWS Bedrock - spciem",
  "owner": "mo.malaka@sailpoint.com",
  "outboundPermissions": [
    "S3:Read",
    "Jira:Admin",
    "EC2:Describe",
    "Bedrock:InvokeModel",
    "AIDevOpsAgentReadOnlyAccess",
    "AmazonBedrockAgentInferenceProfilesCrossRegionPolicy",
    "SecurityAudit",
    "DevOps-Operations"
  ],
  "inboundCallers": ["invoke:engineering-team", "invoke:service-now-workflow"]
}
```

**Sample entitlement (hero — single Bedrock source):**

```json
{
  "entitlementId": "ent_aws_jira_admin",
  "name": "Jira:Admin",
  "attributeName": "outboundPermissions",
  "attributeValue": "Jira:Admin",
  "sourceName": "AWS Bedrock - spciem",
  "accountName": "CloudOps-Navigator:Infra-DevOps-Agent",
  "accessDirection": "outbound",
  "riskScore": 8,
  "privilegeLevel": "high"
}
```

> **Linking rule:** Account entitlement values (`S3:Read`) must match the **Entitlement ID** field in your entitlement type schema. Set **Entitlement ID = `name`** on both `outboundPermissions` and `inboundCallers` entitlement types (see Step 5).

---

## Part B — Create the Web Services source

1. **Admin → Connections → Sources → Create source**
2. Select **Web Services SaaS**
3. Complete base configuration
4. **Connection Settings → Authentication:**

| Setting | Value |
|---------|-------|
| **Authentication Type** | Custom Authentication |
| **Base URL** | `https://main.d12mzah9vzl24s.amplifyapp.com` |

Leave credential fields blank. Save.

---

## Part C — Entitlement types (do this before account entitlements)

ISC allows **only one account attribute per entitlement type**. Do **not** set both `outboundPermissions` and `inboundCallers` to type `group` — you will get *"Multiple Entitlement attributes with same type present"*.

### C1 — Create entitlement type `outboundPermissions`

1. **Entitlement Management → Entitlement Types → Add**
2. Name: **`outboundPermissions`**
3. Add schema attributes: `entitlementId` (string), `name` (string), optional `riskScore` (string), optional `privilegeLevel` (string)
4. Edit entitlement type settings:

| Setting | Value |
|---------|-------|
| **Entitlement ID** | `name` |
| **Entitlement Name** | `name` |

### C2 — Create entitlement type `inboundCallers`

Same steps, name **`inboundCallers`**, same schema shape, **Entitlement ID = `name`**.

---

## Part D — HTTP operations

Go to **Source Setup → HTTP Operations**. Create **five** operations.

### D1 — Test Connection

| Field | Value |
|-------|-------|
| **Operation Type** | Test Connection |
| **Context URL** | `/api/health` |
| **HTTP Method** | `GET` |

### D2 — Account Aggregation

| Field | Value |
|-------|-------|
| **Operation Type** | Account Aggregation |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/accounts` |
| **HTTP Method** | `GET` |
| **Root path** | `$.accounts[*]` |

**Response mapping** (paths relative to each account — do not prefix with `$.accounts[*]`):

| Schema attribute | Attribute path |
|------------------|----------------|
| `accountId` | `accountId` |
| `name` | `name` |
| `nativeIdentity` | `nativeIdentity` |
| `identity` | `identity` |
| `backendId` | `backendId` |
| `displayName` | `displayName` |
| `identityName` | `identityName` |
| `status` | `status` |
| `owner` | `owner` |
| `platform` | `platform` |
| `archetype` | `archetype` |
| `outboundPermissions` | `outboundPermissions` |
| `inboundCallers` | `inboundCallers` |

Preview/test — confirm `outboundPermissions` and `inboundCallers` appear as arrays.

### D2.5 — Group Aggregation (required for API / orchestrator)

The ISC API `POST /entitlements/aggregate/sources/{id}` triggers the **default** operation type **`Group Aggregation`** — not `Group Aggregation-outboundPermissions`.

If you only configure typed group aggregation ops (D3/D4), the API and AgentForge orchestrator will fail with:

> No configuration found for 'Group Aggregation'. Please add at least one operation and try again.

Add **one extra** HTTP operation for API-driven outbound entitlement sync:

| Field | Value |
|-------|-------|
| **Operation Type** | **Group Aggregation** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/entitlements?type=outbound` |
| **HTTP Method** | `GET` |
| **Root path** | `$.entitlements[*]` |

Use the **same response mapping** as D3.

**Also configure the default `group` entitlement type** (this op aggregates as object type `group`, not `outboundPermissions`):

1. **Entitlement Management → Entitlement Types → group** (default)
2. Set **Entitlement ID** = `name` and **Entitlement Name** = `name`
3. In the **Group Aggregation** HTTP op response mapping, include at minimum:

| Schema attribute | Attribute path |
|------------------|----------------|
| `name` | `name` |
| `entitlementId` | `entitlementId` |
| `id` | `id` |
| `value` | `value` |
| `accessDirection` | `accessDirection` |
| `riskScore` | `riskScore` |
| `privilegeLevel` | `privilegeLevel` |

> If you see **`KeyID cannot be empty`** during Group Aggregation, the default `group` entitlement type Entitlement ID field does not match any populated attribute in the HTTP response mapping. Align Entitlement ID = `name` and map `name` → `name`.

> **Inbound** (`inboundCallers`) cannot be triggered by this API on Web Services sources. Run it manually: **Source → Entitlement Aggregation → Specific Types → inboundCallers**.

**Simpler alternative:** Skip the generic **Group Aggregation** op entirely. Run **Group Aggregation - outboundPermissions** and **Group Aggregation - inboundCallers** from the ISC UI (Specific Types). The AgentForge orchestrator marks inbound as manual and can skip the API outbound step too.

### D3 — Group Aggregation — outboundPermissions

| Field | Value |
|-------|-------|
| **Operation Type** | **Group Aggregation - outboundPermissions** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/entitlements?type=outbound` |
| **HTTP Method** | `GET` |
| **Root path** | `$.entitlements[*]` |

| Schema attribute | Attribute path |
|------------------|----------------|
| `entitlementId` | `entitlementId` |
| `name` | `name` |
| `accessDirection` | `accessDirection` |
| `riskScore` | `riskScore` |
| `privilegeLevel` | `privilegeLevel` |

> If aggregation fails with *"No configuration found for Group Aggregation-outboundPermissions"*, this operation is missing or the operation type name does not match the entitlement type name exactly.

### D4 — Group Aggregation — inboundCallers

| Field | Value |
|-------|-------|
| **Operation Type** | **Group Aggregation - inboundCallers** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/entitlements?type=inbound` |
| **HTTP Method** | `GET` |
| **Root path** | `$.entitlements[*]` |

Same response mapping as D3.

### D5 — Dataset aggregation (agent resource)

No separate AgentForge URL — reuse the **accounts** endpoint. ISC Dataset Management aggregates this resource on the source dataset (default `bedrock-agent`).

| Field | Value |
|-------|-------|
| **Operation Type** | **Resource Aggregation - {resource name}** (e.g. `Resource Aggregation-bedrock-agent`) |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/accounts` |
| **HTTP Method** | `GET` |
| **Root path** | `$.accounts[*]` |

The operation type **must** end with the resource name exactly as it appears in
**Dataset Management → Resources**. The connector matches a dataset's resources
to endpoints by this name; the older `Machine Identity Aggregation-{name}` type is
no longer matched and fails the task with *"No resource aggregation endpoints
matched dataset"*. In the UI, start aggregation from **Dataset Management → Datasets → Dataset Aggregations**.

| Resource attribute | Attribute path |
|--------------------|----------------|
| Native Identity / Resource ID | `nativeIdentity` (or `backendId` if your schema uses that) |
| Identity Name / Resource Name | `identityName` |
| `backendId` | `backendId` |
| `identity` | `identity` |
| `owner` | `owner` |
| `platform` | `platform` |

Map **`nativeIdentity`** to the ARN field, **not** `accountId`.

---

## Part E — Schemas

### E1 — Account schema

**Account Management → Account Schema**

| Attribute | Type | Entitlement | Multi-valued |
|-----------|------|-------------|--------------|
| `accountId` | string | No | No |
| `name` | string | No | No |
| `nativeIdentity` | string | No | No |
| `owner` | string | No | No |
| `outboundPermissions` | **outboundPermissions** | Yes | Yes |
| `inboundCallers` | **inboundCallers** | Yes | Yes |

**Edit Account Schema:** Account ID = `accountId`, Account Name = `name`.

### E2 — Dataset + agent resource

The golden packages **do not** contain the dataset or the agent resource. SP-Config
import rejects an agent resource embedded as a source schema
(*"Cannot create resource as schema"*), so AgentForge creates both at runtime via
`POST /sources/v1/{sourceId}/datasets` and `POST /sources/v1/{sourceId}/resources`
on the dataset aggregation step. Create them by hand only if you are not using
the orchestrator:

**Dataset Management → Datasets → Create** (e.g. `bedrock-agent`), then **Resources → Create Resource** associated with that dataset.

Resource type: **`std:agent`** (AI agent). Set **Resource ID** = `nativeIdentity` and **Resource Name** = `identityName`.

| Attribute | Type |
|-----------|------|
| `nativeIdentity` | string — Resource ID |
| `identityName` | string — Resource Name |
| `owner` | string — work email of an ISC identity |
| `platform` | string |

The **Resource Aggregation** response mapping must include `owner` → `owner` (already in golden packages).

Because ISC generates dataset and resource IDs as `customer:` plus a normalized
form of the name, the created dataset for `bedrock-agent` is addressed as
`customer:bedrock-agent` while its resource is still *named* `bedrock-agent`. The
operation type keys off the unprefixed resource name, so it is
`Resource Aggregation-bedrock-agent`.

---

## Part F — Run aggregations (order matters)

**Manual (ISC UI):**

```
1. Group Aggregation → outboundPermissions
2. Group Aggregation → inboundCallers
3. Dataset Management → Datasets → bedrock-agent → Start Aggregation
4. Account Aggregation
```

**Automated (AgentForge orchestrator):** **Run full sync** on the dashboard runs the same sequence via ISC APIs, including entitlement aggregation twice and machine account mappings. See [Part K](#part-k--isc-demo-orchestrator).

**Dataset aggregation:** AgentForge first ensures the platform dataset and
`std:agent` resource exist, then calls
`POST /sources/v1/{sourceId}/datasets/{datasetId}/aggregate`. Dataset and
resource IDs are generated by ISC with a `customer:` prefix. The legacy
`POST /v2026/sources/{sourceId}/aggregate-agents` endpoint is no longer used.

### Verify after aggregation

| Check | Location | Expected |
|-------|----------|----------|
| Entitlement catalog | Source → Entitlements or Access Model | S3:Read, invoke:engineering-team, etc. |
| Accounts | Source → Accounts | DevOps-Bot-Prod enabled |
| Entitlement assignments | Account → Entitlement Assignments | 6 items (not empty) |
| AI agents | Admin → AI Agents | DevOps-Bot-Prod listed |

---

## Part G — Link account to AI agent

Correlating in **Machine Accounts** alone may not populate **AI Agent → Accounts**.

**Automated:** **Run full sync** applies machine account mappings via `PUT /v2026/sources/{sourceId}/machine-account-mappings` (nativeIdentity → nativeIdentity). See [Part K](#part-k--isc-demo-orchestrator).

**Manual:**

ISC does **not** show **Add account** on **AI Agent → Accounts**. Correlate from the **account** side:

1. **Admin → Identity Management → Accounts → Uncorrelated Accounts** (or Human Accounts)
2. Find the Bedrock / IAM / GWS account → **Actions → Update Correlation → Machine**
3. Select **CloudOps-Navigator:Infra-DevOps-Agent**
4. Or: open the **source account** → set **Machine Identity** to the agent

**Automated:** **Run full sync** applies machine account mappings via `PUT /v2026/sources/{sourceId}/machine-account-mappings`. Use `nativeIdentity` → `nativeIdentity` on the Bedrock source (ARN alignment).

---

## Part H — Demo walkthrough (inbound / outbound access)

### Hero screen — AI Agent → Access

1. **Admin → Identity Management → Identities → AI Agents**
2. Open **DevOps-Bot-Prod**
3. **Access** tab

**Outbound talk track:**

> These are outbound permissions — what this agent can reach in connected systems.

Show: `S3:Read`, `EC2:Describe`, `Jira:Admin`, `Bedrock:InvokeModel` (attribute `outboundPermissions`).

**Inbound talk track:**

> These are inbound callers — principals allowed to invoke this agent.

Show: `invoke:engineering-team`, `invoke:service-now-workflow` (attribute `inboundCallers`).

### Supporting screens

| Screen | Purpose |
|--------|---------|
| Source account → Attributes | Raw connector data |
| Source account → Entitlement Assignments | Proves catalog linking worked |
| Source → Entitlements | Entitlement catalog |
| Setup page (`/setup`) | Checklist, copy endpoints, bulk create on `/agents` |

### Identity Graph (optional)

- Open from **AI Agent → View in Identity Graph**
- With the single-source hero, expect **~12 blue outbound leaves + 2 inbound** under one Bedrock source node (after account aggregation links entitlements)
- Configure [Part M](#part-m--privilege-classification-identity-graph-colors) for colored **privilege rings** on grouped nodes
- **Do not** add Account ID filters unless you know the graph’s internal ID (wrong filter = empty graph)
- Alternative: **Home → Identity Graph** → search `Jira:Admin` for reverse path

**One-liner for audiences:**

> Entitlements are the individual permissions; access is the full inbound/outbound picture. AIS shows that on the agent Access tab.

---

## Part I — Provisioning (add/remove entitlement, disable agent)

AgentForge implements **write-back** so ISC provisioning plans can change agent access and status. After a provision completes, re-run **account aggregation** on the source.

### I1 — HTTP operations to add

Go to **Source Setup → HTTP Operations** and create **five** additional operations (same base URL as aggregation).

#### Add Entitlement — outboundPermissions

| Field | Value |
|-------|-------|
| **Operation Type** | **Add Entitlement - outboundPermissions** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/provision/add-entitlement` |
| **HTTP Method** | `POST` |
| **Content-Type** | `application/json` |

**Request body mapping** (ISC plan variables):

| Body field | Value |
|------------|-------|
| `nativeIdentity` | `$plan.nativeIdentity$` |
| `accountId` | `$plan.accountId$` |
| `outboundPermissions` | `$plan.outboundPermissions$` |

AgentForge also accepts `entitlement` + `entitlementType: outboundPermissions`.

#### Add Entitlement — inboundCallers

| Field | Value |
|-------|-------|
| **Operation Type** | **Add Entitlement - inboundCallers** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/provision/add-entitlement` |
| **HTTP Method** | `POST` |

| Body field | Value |
|------------|-------|
| `nativeIdentity` | `$plan.nativeIdentity$` |
| `inboundCallers` | `$plan.inboundCallers$` |

#### Remove Entitlement — outboundPermissions / inboundCallers

| Operation Type | Context URL |
|----------------|-------------|
| **Remove Entitlement - outboundPermissions** | `/api/connectors/web-services/aws-bedrock/provision/remove-entitlement` |
| **Remove Entitlement - inboundCallers** | `/api/connectors/web-services/aws-bedrock/provision/remove-entitlement` |

Same body mapping as add, using the entitlement attribute being removed.

#### Disable Account

| Field | Value |
|-------|-------|
| **Operation Type** | **Disable Account** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/provision/disable-account` |
| **HTTP Method** | `POST` |

| Body field | Value |
|------------|-------|
| `nativeIdentity` | `$plan.nativeIdentity$` |
| `accountId` | `$plan.accountId$` |

Sets agent status to **inactive**. Account aggregation returns platform-native disabled status (`FAILED` on Bedrock, `DELETED` on Vertex, `Failed` on Azure).

#### Enable Account (optional)

| Field | Value |
|-------|-------|
| **Operation Type** | **Enable Account** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/provision/enable-account` |
| **HTTP Method** | `POST` |

Same body as disable. Restores `active` status.

#### Get Object (optional)

| Field | Value |
|-------|-------|
| **Operation Type** | **Get Object** |
| **Context URL** | `/api/connectors/web-services/aws-bedrock/account?nativeIdentity=$plan.nativeIdentity$` |
| **HTTP Method** | `GET` |

Root path: `$.account` or `$.object`.

### I2 — Test provisioning with curl

Replace `NATIVE_IDENTITY` with an agent ARN from account aggregation:

```bash
# Add outbound permission
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/connectors/web-services/aws-bedrock/provision/add-entitlement \
  -H "Content-Type: application/json" \
  -d '{"nativeIdentity":"NATIVE_IDENTITY","outboundPermissions":"DynamoDB:Read"}'

# Remove outbound permission
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/connectors/web-services/aws-bedrock/provision/remove-entitlement \
  -H "Content-Type: application/json" \
  -d '{"nativeIdentity":"NATIVE_IDENTITY","outboundPermissions":"Jira:Admin"}'

# Disable agent account
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/connectors/web-services/aws-bedrock/provision/disable-account \
  -H "Content-Type: application/json" \
  -d '{"nativeIdentity":"NATIVE_IDENTITY"}'
```

Successful responses include `success: true` and an updated `account` object.

### I3 — Demo flow with ISC

1. Create an **access profile** with outbound entitlements (e.g. add `DynamoDB:Read`)
2. Assign the profile to a user and provision to the linked AI agent account
3. Re-run **account aggregation**
4. Open **AI Agent → Access** — new outbound permission appears
5. Run a **certification** or manual revoke to remove `Jira:Admin`
6. Re-aggregate — permission disappears on the Access tab
7. **Disable** the account via provisioning — account shows disabled in **Sources → Accounts**

### I4 — Direct AgentForge API (optional)

`PATCH /api/agents/{id}` accepts:

```json
{
  "status": "inactive",
  "entitlements": ["S3:Read", "EC2:Describe"],
  "inbound_access": ["invoke:engineering-team"]
}
```

Useful for local testing without ISC.

---

## Part J — Simulate authorization (Phase 3)

AgentForge evaluates **effective access** at runtime: assert a principal and requested permission, get **allow** or **deny**. This simulates enforcement after ISC governance — without connecting to real cloud APIs.

### J1 — Authorize API

```
POST /api/agents/{id}/authorize
```

**Outbound** (what the agent can reach):

```json
{
  "principal": "DevOps-Bot-Prod",
  "direction": "outbound",
  "resource": "S3",
  "action": "Read"
}
```

Or use a full permission string:

```json
{
  "principal": "DevOps-Bot-Prod",
  "direction": "outbound",
  "permission": "S3:Read"
}
```

**Inbound** (who can invoke the agent):

```json
{
  "principal": "jane.doe@sailpoint.com",
  "direction": "inbound",
  "action": "invoke",
  "caller": "invoke:engineering-team"
}
```

### J2 — Evaluation rules

| Check | Result |
|-------|--------|
| Agent `status` is `inactive` | **deny** (`agent_disabled`) |
| Outbound: `Resource:Action` not in `outboundPermissions` | **deny** (`agent_outbound_allowlist`) |
| Inbound: `caller` not in `inboundCallers` | **deny** (`agent_inbound_allowlist`) |
| Match found | **allow** |

Responses use HTTP **200** for allow and **403** for deny. The JSON body always includes `decision`, `reason`, `policy`, and `effective_access`.

### J3 — Demo flow (govern → provision → enforce)

**Automated:** After full sync, use **Run govern + enforce** on the dashboard. It runs authorize allow → revoke entitlement (AgentForge) → unoptimized account aggregation → authorize deny.

**Manual:**

1. **Before revoke:** authorize `S3:Read` → **allow**
2. **Certify / revoke** `Jira:Admin` in ISC → provisioning removes it → re-aggregate
3. Authorize `Jira:Admin` → **deny** (no longer in effective outbound)
4. **Disable** agent via provisioning → authorize any request → **deny** (`agent_disabled`)

```bash
AGENT_ID=agt_xxx

# Allow outbound read
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/agents/$AGENT_ID/authorize \
  -H "Content-Type: application/json" \
  -d '{"principal":"DevOps-Bot-Prod","direction":"outbound","permission":"S3:Read"}'

# Deny after revoke
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/agents/$AGENT_ID/authorize \
  -H "Content-Type: application/json" \
  -d '{"principal":"DevOps-Bot-Prod","direction":"outbound","permission":"Jira:Admin"}'

# Inbound allow
curl -s -X POST https://main.d12mzah9vzl24s.amplifyapp.com/api/agents/$AGENT_ID/authorize \
  -H "Content-Type: application/json" \
  -d '{"principal":"jane.doe@sailpoint.com","direction":"inbound","caller":"invoke:engineering-team"}'
```

### J4 — UI simulate panel

Open any agent detail page in AgentForge. The **Simulate authorization** panel lets you pick inbound/outbound, principal, and permission — then shows allow/deny with policy and matched entitlement.

---

## Part K — ISC demo orchestrator

Run the full AgentForge + ISC demo from the **dashboard** without Postman. AgentForge calls ISC v2026 APIs server-side using OAuth client credentials.

### K1 — What still requires one-time ISC setup

The orchestrator does **not** replace initial connector bootstrap. Configure once in ISC (or export golden source JSON):

| One-time in ISC | Why |
|-----------------|-----|
| Web Services source + HTTP operations | Poorly documented create-source API |
| Entitlement types (`outboundPermissions`, `inboundCallers`) | No clean public create API |
| Account schema + dataset / agent resource | AIS Dataset Management (`POST /sources/{id}/datasets`) |

After bootstrap, the orchestrator handles runtime demo steps. If Config Hub import does not create the dataset row, full sync or source verify will call **create dataset** and attach an `std:agent` resource.

### K2 — Environment variables

Set on AgentForge (`.env.local` locally, Amplify environment variables in production). Copy from [`.env.example`](./.env.example).

| Variable | Required | Description |
|----------|----------|-------------|
| `ISC_TENANT` | Yes | Tenant slug (e.g. `acme`) |
| `ISC_CLIENT_ID` | Yes | API client ID |
| `ISC_CLIENT_SECRET` | Yes | API client secret — **server only, never expose to browser** |
| Platform source IDs | Yes | Set on **Demo → ISC sources** (saved server-side; one ID per Bedrock / Vertex / Foundry source) |
| Dataset IDs | No | Same panel — default `bedrock-agent` / `gcp-agent` / `foundry-agent`. Env aliases: `ISC_MIS_DATASET_IDS_BEDROCK`, etc. |
| `ISC_API_VERSION` | No | Default `v2026` |
| `ISC_DOMAIN` | No | Default `identitynow.com` |
| `ISC_DEMO_AGENT_ID` | No | Agent for govern + enforce (default `agt_demo_aws_bedrock`) |

**Minimum OAuth scopes:**

- `idn:sources:read`, `idn:sources:manage`
- `idn:accounts:read`
- `idn:entitlement:manage`
- `idn:mis-agents:aggregate`
- `idn:mis-account:read`

Verify configuration:

```bash
curl -s https://main.d12mzah9vzl24s.amplifyapp.com/api/demo/config | jq
```

Expected: `"configured": true` with tenant and sourceId.

**Amplify note:** If `configured` is `false` but vars are set in the console, ensure `amplify.yml` is deployed and trigger a **new build** (not just “Redeploy this version” of an old build from before vars were set).

### K3 — Demo modes

| Mode | Button | Steps |
|------|--------|-------|
| **Full sync** | Run full sync | Bulk create → entitlement agg ×2 → dataset agg → account agg → machine account mappings → verify |
| **Govern + enforce** | Run govern + enforce | Authorize allow → revoke entitlement → unoptimized account agg → authorize deny |

**Full sync** ISC API calls (AgentForge server → ISC):

| Step | ISC API |
|------|---------|
| Entitlement aggregation | `POST /v2026/entitlements/aggregate/sources/{sourceId}` |
| Dataset aggregation | `POST /sources/v1/{sourceId}/datasets/{datasetId}/aggregate` |
| List datasets | `GET /sources/v1/{sourceId}/datasets` |
| Create dataset | `POST /sources/v1/{sourceId}/datasets` |
| List/create resources | `GET/POST /sources/v1/{sourceId}/resources` |
| Account aggregation | `POST /v2026/sources/{sourceId}/load-accounts` |
| Machine account mappings | `PUT /v2026/sources/{sourceId}/machine-account-mappings` |
| Verify | `GET /v2026/accounts`, `GET /v2026/machine-accounts` |

Aggregation steps return a task ID; the UI polls `GET /beta/task-status/{taskId}` until complete.

**Govern + enforce** defaults:

| Setting | Default |
|---------|---------|
| Allow permission | `S3:Read` |
| Revoke entitlement | `Jira:Admin` |
| Revoke path | AgentForge direct (`remove-entitlement`) — reliable when ISC UI actions are missing |
| Principal | `demo-user` |

Override these in the orchestrator panel before running.

### K4 — Dashboard usage

1. Open AgentForge dashboard
2. Confirm green **ISC connected** banner (tenant + source ID)
3. Set platform, bulk count, demo agent ID, allow/revoke permissions if needed
4. Click **Run full sync** — wait for the step log to complete
5. In ISC, confirm **AI Agent → Access** shows inbound + outbound
6. Click **Run govern + enforce** — confirm allow then deny in the step log

### K5 — Demo API (optional)

Same steps via API if scripting outside the UI:

```bash
# List modes and steps
curl -s https://main.d12mzah9vzl24s.amplifyapp.com/api/demo/run | jq

# Run one step
curl -s -X POST "https://main.d12mzah9vzl24s.amplifyapp.com/api/demo/run?mode=full-sync" \
  -H "Content-Type: application/json" \
  -d '{"step":"entitlement-aggregation"}' | jq

# Poll ISC task
curl -s https://main.d12mzah9vzl24s.amplifyapp.com/api/demo/task/{taskId} | jq
```

### K6 — Architecture

```
ONE-TIME (ISC UI)
  Web Services source + HTTP ops + entitlement types + dataset/resource
                    ↓
DEMO (AgentForge orchestrator)
  AgentForge bulk create
  → ISC entitlement agg (×2)
  → ISC dataset aggregation (/sources/v1/{sourceId}/datasets/{datasetId}/aggregate)
  → ISC account agg
  → ISC machine account mappings
  → ISC verify
  → AgentForge authorize (allow)
  → AgentForge revoke (or ISC access-request)
  → ISC account agg (unoptimized)
  → AgentForge authorize (deny)
```

---

## Part M — Privilege classification (Identity Graph colors)

Identity Graph uses **node fill colors** for access object type (blue = assigned entitlement, grey = nested, green = role, pink = access profile) and **colored rings** around nodes for **privilege mix** (high / medium / low). AgentForge cannot paint the graph directly — you configure **Privilege Classification** in ISC after entitlements aggregate.

### What AgentForge sends

Each hero entitlement in the group aggregation payload includes:

| Field | Example | Purpose |
|-------|---------|---------|
| `riskScore` | `8` | Numeric hint (0–10 scale in seed data) |
| `privilegeLevel` | `high` | Optional string hint: `high`, `medium`, or `low` |

Map both fields in your **group aggregation response mapping** if you add `privilegeLevel` to the entitlement type schema (optional but recommended for criteria-based classification).

### M1 — Enable privilege classification on the Bedrock source

1. **Admin → Connections → Sources →** your Bedrock Web Services source
2. **Entitlement Management → Privilege Classification**
3. Enable **Automatic Privilege Classification**

### M2 — Recommended: custom criteria using `riskScore`

Use **Define custom criteria logic** on each privilege level tab:

| Direct privilege | Criteria (Attribute = `riskScore`, Operator = Contains or Equals) |
|------------------|---------------------------------------------------------------------|
| **High** | `7`, `8`, `9` |
| **Medium** | `5`, `6` |
| **Low** | `3`, `4` |

Save, then re-run **Group Aggregation** for `outboundPermissions` and `inboundCallers` if entitlements were already aggregated.

### M3 — Alternative: criteria on `privilegeLevel`

If you mapped `privilegeLevel` in the entitlement schema and group aggregation:

| Direct privilege | Criteria (Attribute = `privilegeLevel`, Operator = Equals) |
|------------------|-------------------------------------------------------------|
| **High** | `high` |
| **Medium** | `medium` |
| **Low** | `low` |

### M4 — Alternative: name-based criteria

Match entitlement `name` for demo polish without schema changes:

| Direct privilege | Example `name` Contains values |
|------------------|--------------------------------|
| **High** | `Admin`, `Secrets`, `Security Auditor`, `AIDevOps` |
| **Medium** | `SecurityAudit`, `service-now`, `DevOps-Operations`, `Inference` |
| **Low** | `Read`, `Describe`, `Viewer`, `engineering-team` |

### M5 — Verify in Identity Graph

1. Open **AI Agent → View in Identity Graph**
2. **Help → Legend** — confirm ring colors for high / medium / low
3. Hover a grouped source node — percentage of high-privilege entitlements should reflect mixed `riskScore` values from the hero seed

> **Note:** Ring indicators appear on access objects that **contain** classified entitlements (e.g. grouped source nodes). Individual blue entitlement leaves stay blue; privilege shows as rings on parent/group nodes.

### E2b — Optional agent resource attributes (rich Details tab)

To populate **Description**, **foundationModel**, etc. on **AI Agent → Details**:

1. **Dataset Management → Resources → bedrock-agent → Schema → Edit**
2. Add string attributes: `description`, `foundationModel`, `role`, `version`, `agentAliasStatus`
3. Dataset aggregation HTTP response mapping — add paths from the accounts payload:

| Machine identity attribute | Account payload path |
|----------------------------|----------------------|
| `description` | `description` |
| `foundationModel` | `foundationModel` |
| `role` | `role` |
| `version` | `version` |
| `agentAliasStatus` | `agentAliasStatus` |

4. Re-run dataset + account aggregation

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Still shows `DevOps-Bot-Prod` / 4 entitlements | Old AgentForge data or stale ISC aggregation | [A0](#a0--load-hero-agents-phase-1--do-this-first) full-store reset; redeploy AgentForge; re-aggregate Bedrock source |
| Access shows only 6 entitlements | Stale aggregation before hero seed update | Full-store reset; re-run group + account aggregation on Bedrock |
| *No configuration for Group Aggregation-AWSManagedPolicies* | Missing typed HTTP operation | Add **Group Aggregation - AWSManagedPolicies** on the AWS IAM source (L2c) |
| *Multiple Entitlement attributes with same type* | Both access fields typed as `group` | Create separate types `outboundPermissions` and `inboundCallers` |
| *No configuration for Group Aggregation-outboundPermissions* | Missing HTTP operation | Add operation type **Group Aggregation - outboundPermissions** (D3) |
| *datasetIds empty* on dataset agg | No dataset selected | Create a dataset in **Dataset Management**; use that dataset id (e.g. `bedrock-agent`) |
| Attributes populated, Entitlement Assignments empty | Entitlement ID mismatch | Set **Entitlement ID = `name`**; re-run group + account agg |
| Catalog shows `S3 Read`, account has `S3:Read` | Display normalization | OK if Entitlement Assignments on account are populated |
| AI Agent → Access empty | Account not linked to agent | Correlate on **AI Agent → Accounts** |
| AI Agent → Accounts empty | nativeIdentity / ARN mismatch | Align ARN; re-aggregate; link manually |
| Identity Graph has no privilege rings | Privilege classification not configured | [Part M](#part-m--privilege-classification-identity-graph-colors) |
| Graph *Filter Returned No Results* | Bad Account ID filter | Clear filters in Explorer |
| Import fails: *Cannot create resource as schema* | Package contains a `std:agent` resource as a source schema — ISC no longer accepts this | Use a current golden package (agent schemas are stripped); the dataset and resource are created by the orchestrator instead |
| Dataset agg task fails: *No resource aggregation endpoints matched dataset '`customer:…`'* | Source still has the retired `Machine Identity Aggregation-{name}` operation | Re-import a current golden package, which types the operation **Resource Aggregation-{resource name}** (e.g. `Resource Aggregation-bedrock-agent`), or rename it in **HTTP Operations** |
| Dataset agg fails after renaming a resource | Operation type no longer ends with the resource name | Run **Verify** under **Demo → Web Services source IDs** — it now reports resources whose aggregation operation is missing |
| Dataset appears on the wrong source (e.g. `bedrock-agent` on the Foundry source) while the right source shows **0 datasets** | The source ID saved for that platform belongs to a different source. Note that the legacy `ISC_SOURCE_ID` env var is applied to **AWS Bedrock only**, so a leftover value silently fills that slot | Run **Verify** — it compares the source's endpoint slug (`/aws-bedrock/`, `/gcp-vertex/`, `/azure-ai-foundry/`) against the platform it is saved under and names the mismatch. Fix the source ID, or unset `ISC_SOURCE_ID` and use `ISC_SOURCE_ID_AWS_BEDROCK` |
| Source is **Not Responding**, Base URL is `http://localhost:...` | Golden package was imported from a laptop, so the local URL was baked into the source | Verify the source under **Demo → Web Services source IDs** and click **Repoint source at this deployment**, or re-import the package from the deployed URL |
| Only one source has the deployed URL | The other sources were imported during an earlier (local or older) session | Repair each remaining source as above — imports do not retroactively update sources created earlier |
| 0 accounts in aggregation | Wrong URL or root path | `$.accounts[*]`; platform-specific path |
| KeyID / 0 accounts (ISC) | Wrong endpoint | Use Web Services `/accounts`, not `/connectors/aws-bedrock/agents` |
| Provision succeeds but ISC unchanged | No re-aggregation | Re-run account aggregation after provision |
| Provision 404 | Wrong platform URL or nativeIdentity | Match source platform path; use ARN from account agg |
| Remove entitlement 404 | Value not on agent | Confirm exact entitlement string (`S3:Read` vs `S3 Read`) |
| Orchestrator: ISC not configured | Missing env vars | Set `ISC_TENANT`, `ISC_CLIENT_ID`, `ISC_CLIENT_SECRET`, `ISC_SOURCE_ID` |
| Orchestrator: auth failed | Bad client credentials or scopes | Verify OAuth client scopes (Part K2) |
| Orchestrator: task timed out | Large tenant / slow agg | Re-run single step via `/api/demo/run`; check ISC task monitor |
| Orchestrator: machine mappings failed | Experimental API | Ensure `ISC_API_VERSION=v2026`; check source has MIS enabled |
| Group agg `KeyID cannot be empty` | Generic **Group Aggregation** uses default `group` schema; Entitlement ID field not mapped | Set `group` type Entitlement ID = `name`; map `name` in response — or use typed ops from UI only (D3/D4) |

---

## Glossary

| Term | Definition |
|------|------------|
| **Entitlement** | A named permission (`S3:Read`, `invoke:engineering-team`) |
| **Access** | The overall picture of what an identity can do — shown on **AI Agent → Access** |
| **Outbound** | What the agent can reach (`outboundPermissions`) |
| **Inbound** | Who can invoke the agent (`inboundCallers`) |
| **Account** | Connector object on the Web Services source |
| **Dataset** | Aggregation unit that groups one or more resources (AgentForge uses one agent dataset per platform) |
| **Resource** | Typed schema collected by a dataset (`std:agent` for AI agents) |
| **AI Agent** | Governed non-human identity produced by dataset aggregation |

---

## Quick checklist

```
☐ Hero agents loaded — full-store reset (Part A0)
☐ One-time ISC bootstrap (source, HTTP ops, entitlement types, dataset + resource)
☐ AgentForge ISC env vars set (Part K2)
☐ Web Services Bedrock source + test connection
☐ Entitlement types: outboundPermissions, inboundCallers (Entitlement ID = name)
☐ Group aggregation maps riskScore (+ optional privilegeLevel)
☐ HTTP ops: test, account, group×2, dataset/agent aggregation
☐ Account schema + dataset (`bedrock-agent`) with `std:agent` resource
☐ Aggregate: group outbound → group inbound → dataset → account
     (or Run full sync on dashboard)
☐ AI Agent linked to Bedrock account
☐ AI Agent → Access shows ~14 entitlements on one source
☐ Optional: privilege classification for Identity Graph rings (Part M)
☐ Provisioning HTTP ops: add/remove entitlement, disable account
☐ Authorize API: allow known permission, deny revoked/disabled
     (or Run govern + enforce on dashboard)
☐ Demo!
```
