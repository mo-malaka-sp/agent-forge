# AgentForge

**AgentForge** is an internal R&D tool that lets Sales Engineers spin up **synthetic AI agents** for identity governance demos — without connecting to real external AI infrastructure.

Create mock agents with **inbound** and **outbound** access, then expose them through Web Services APIs that a SailPoint **Web Services SaaS** connector and **Agent Identity Security** can aggregate.

**SailPoint integration:** [Setup Guide](/setup) (also in repo as [CONNECTOR_SETUP.md](./CONNECTOR_SETUP.md))

## What it does

- **Web UI** — create agents with outbound permissions and inbound callers; bulk-create 5/10/20 per platform
- **Web Services accounts API** — `accounts[]` with `outboundPermissions` and `inboundCallers` for ISC account aggregation
- **Web Services entitlements API** — entitlement catalog for group aggregation (`?type=outbound` / `?type=inbound`)
- **Provisioning API** — ISC write-back for add/remove entitlement and disable/enable account
- **Authorize API** — runtime allow/deny against effective inbound/outbound access
- **ISC demo orchestrator** — run full sync and govern + enforce from the dashboard (no Postman)
- **Dataset aggregation** — reuse the accounts endpoint for ISC dataset aggregation (same `nativeIdentity` ARN)
- **Reference API** — optional cloud-native JSON shapes (Bedrock, Vertex, Foundry)

## Demo target in ISC

| Direction | AgentForge field | ISC demo screen |
|-----------|------------------|-----------------|
| Outbound | `outboundPermissions` | **AI Agent → Access** |
| Inbound | `inboundCallers` | **AI Agent → Access** |

See [CONNECTOR_SETUP.md](./CONNECTOR_SETUP.md) for the full ISC configuration and demo walkthrough.

## Quick start

```bash
cd ~/developments/agent-forge
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

### One-click ISC demo (recommended)

1. **One-time in ISC** — configure the Web Services source, HTTP operations, entitlement types, and dataset/resource ([setup guide](./CONNECTOR_SETUP.md))
2. **Set ISC env vars** — copy [`.env.example`](./.env.example) to `.env.local` and fill in tenant credentials
3. Open the dashboard → **ISC demo orchestrator**
4. **Run full sync** — bulk create agents, run ISC aggregations, link machine accounts, verify
5. **Run govern + enforce** — authorize allow → revoke entitlement → re-aggregate → authorize deny

### Bulk-create demo agents (manual)

1. Open the dashboard
2. **Quick bulk create** — pick platform (AWS / GCP / Azure) and **5, 10, or 20**
3. Run ISC aggregations per the [setup guide](./CONNECTOR_SETUP.md)

### Create a single agent via API

```bash
curl -s -X POST http://127.0.0.1:3000/api/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "DevOps-Bot-Prod",
    "archetype": "devops_bot",
    "deployment_provider": "aws_bedrock",
    "deployment_config": {
      "region": "us-east-1",
      "account_id": "123456789012"
    },
    "metadata": {
      "owner": "platform-ops@sailpoint.com",
      "department": "Engineering",
      "risk_level": "High"
    },
    "entitlements": ["S3:Read", "Jira:Admin"],
    "inbound_access": ["invoke:engineering-team", "invoke:service-now-workflow"]
  }' | jq
```

## Web Services endpoints (ISC)

| Platform | Accounts (`$.accounts[*]`) | Entitlements (`$.entitlements[*]`) |
|----------|------------------------------|-------------------------------------|
| AWS Bedrock | `/api/connectors/web-services/aws-bedrock/accounts` | `.../entitlements?type=outbound` or `?type=inbound` |
| GCP Vertex | `/api/connectors/web-services/gcp-vertex/accounts` | same pattern |
| Azure AI Foundry | `/api/connectors/web-services/azure-ai-foundry/accounts` | same pattern |

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/agents` | List all agents (unified) |
| `POST` | `/api/agents` | Create a synthetic agent |
| `POST` | `/api/agents/bulk` | Bulk create 5, 10, or 20 random agents |
| `GET` | `/api/agents/{id}` | Get a single agent |
| `PATCH` | `/api/agents/{id}` | Update status or access lists |
| `POST` | `/api/agents/{id}/authorize` | Assert access → allow/deny |
| `DELETE` | `/api/agents/{id}` | Remove an agent |
| `GET` | `/api/connectors/web-services/{platform}/accounts` | ISC account aggregation |
| `GET` | `/api/connectors/web-services/{platform}/entitlements` | ISC entitlement catalog |
| `POST` | `/api/connectors/web-services/{platform}/provision/*` | ISC provisioning (add/remove/disable) |
| `GET` | `/api/demo/config` | ISC connection status (no secrets) |
| `GET` | `/api/demo/run` | Demo modes and step catalog |
| `POST` | `/api/demo/run?mode=full-sync` | Run a single demo step |
| `GET` | `/api/demo/task/{taskId}` | Poll ISC aggregation task status |

### Authorize (runtime enforcement)

```bash
curl -s -X POST http://127.0.0.1:3000/api/agents/{id}/authorize \
  -H "Content-Type: application/json" \
  -d '{
    "principal": "jane.doe@sailpoint.com",
    "direction": "outbound",
    "permission": "S3:Read"
  }' | jq
```

Returns `decision: "allow"` (HTTP 200) or `decision: "deny"` (HTTP 403) with `effective_access` and `policy`.

## Configuration

Copy [`.env.example`](./.env.example) to `.env.local` for local development. On Amplify, set the same variables in the environment settings.

### AgentForge (optional)

```bash
# Override auto-detected base URL (Amplify usually does not need this)
AGENTFORGE_BASE_URL=https://your-app.amplifyapp.com
NEXT_PUBLIC_BASE_URL=https://your-app.amplifyapp.com
```

AgentForge auto-detects the public URL from request headers on Amplify when these are unset.

### ISC demo orchestrator (server-side only)

Required for **Run full sync** and **Run govern + enforce** on the dashboard.

| Variable | Required | Description |
|----------|----------|-------------|
| `ISC_TENANT` | Yes | ISC tenant name (e.g. your company slug) |
| `ISC_CLIENT_ID` | Yes | API client or PAT client ID |
| `ISC_CLIENT_SECRET` | Yes | API client secret |
| `ISC_SOURCE_ID` | Yes | Web Services source ID for AgentForge |
| `ISC_API_VERSION` | No | API version prefix (default `v2026`) |
| `ISC_DOMAIN` | No | API domain (default `identitynow.com`) |
| `ISC_DEMO_AGENT_ID` | No | Agent used in govern + enforce (default `agt_demo_aws_bedrock`) |

**OAuth scopes** for the API client (minimum):

- `idn:sources:read`, `idn:sources:manage`
- `idn:accounts:read`
- `idn:entitlement:manage`
- `idn:mis-agents:aggregate`
- `idn:mis-account:read`

Never expose `ISC_CLIENT_SECRET` to the browser — AgentForge calls ISC only from server routes.

**AWS Amplify:** Console environment variables are **not** passed to Next.js API routes at runtime by default. This repo includes [`amplify.yml`](./amplify.yml), which writes `ISC_*` vars into `.env.production` during build. After changing env vars in Amplify, **redeploy** (a new build is required).

### Demo modes

| Mode | Steps | What it does |
|------|-------|--------------|
| **Full sync** | 6 (+ entitlement agg ×2) | Bulk create → entitlement agg → dataset agg → account agg → machine account mappings → verify |
| **Govern + enforce** | 4 | Authorize allow → revoke entitlement (AgentForge) → unoptimized account agg → authorize deny |

### Demo API examples

```bash
# Check ISC is configured
curl -s http://127.0.0.1:3000/api/demo/config | jq

# List demo modes and steps
curl -s http://127.0.0.1:3000/api/demo/run | jq

# Run one step (full-sync mode)
curl -s -X POST "http://127.0.0.1:3000/api/demo/run?mode=full-sync" \
  -H "Content-Type: application/json" \
  -d '{"step":"bulk-create","deployment_provider":"aws_bedrock","count":5}' | jq

# Poll an ISC aggregation task
curl -s http://127.0.0.1:3000/api/demo/task/{taskId} | jq
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run db:reset` | Clear stored agents |
