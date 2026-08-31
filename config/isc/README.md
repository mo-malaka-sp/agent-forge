# Golden SP-Config — AgentForge ISC bootstrap

Import **Web Services SaaS** sources into a new ISC tenant in minutes instead of hand-building Parts B–E in [CONNECTOR_SETUP.md](../../CONNECTOR_SETUP.md).

## Two audiences

| Who | What they do |
|-----|----------------|
| **Demo user / SE** | Open AgentForge **Setup → Prep your ISC tenant** — choose **Option 1** (Configuration Hub) or **Option 2** (API import with ORG_ADMIN PAT). |
| **Maintainer (you, once)** | Take exports from a working tenant, templatize, commit under `golden/`. |

---

## Demo user flow

1. Go to **AgentForge → Setup → Prep your ISC tenant**.
2. **Option 1 — Configuration Hub:** Solution Center → Configuration Hub → **Uploads** → upload each JSON → prepare draft → deploy (no PAT).
3. **Option 2 — API import:** follow the ORG_ADMIN PAT guide on Setup → preview → run import (PAT is not stored).
4. **Connections → Sources** — test connection on each source. Confirm **Dataset Management** lists the agent dataset (`bedrock-agent` / `gcp-agent` / `foundry-agent`). If it is missing, Demo full sync will `POST /sources/{id}/datasets`.
5. **AgentForge Setup → Step 3** — apply privilege classification (paste target source IDs + ORG_ADMIN PAT). Required for Identity Graph rings.
6. Set `ISC_TENANT`, `ISC_CLIENT_ID`, `ISC_CLIENT_SECRET` on AgentForge; open **Demo → ISC sources** and paste source IDs.

Option 2 uses `POST /beta/sp-config/import` with a user-supplied PAT (session only). The demo OAuth client on Amplify keeps narrower scopes for orchestrator runtime — it is not used for bootstrap import.

---

## Maintainer flow (one-time, publish golden files)

This is the step that confused “Step 2” in earlier docs — it is **not** something every tenant admin runs.

### Why templatize?

Your working export JSON contains your Amplify URL hardcoded in HTTP operation paths, for example:

```
https://main.d12mzah9vzl24s.amplifyapp.com/api/connectors/web-services/aws-bedrock/accounts
```

Other deployments (local, another Amplify app, a customer fork) need a **different** host. We store one golden copy in git with a placeholder:

```
{{AGENTFORGE_BASE_URL}}/api/connectors/web-services/aws-bedrock/accounts
```

When a user clicks **Download** on Setup, AgentForge substitutes the current public URL and serves a ready-to-import file.

### What you do once

1. **Copy your 3 VS Code exports** into this repo:

   ```
   config/isc/exports/aws-bedrock.raw.json
   config/isc/exports/gcp-vertex.raw.json
   config/isc/exports/azure-ai-foundry.raw.json
   ```

   (Raw exports are gitignored — they may contain tenant-specific data.)

2. **Run the prepare script** (maintainer only):

   ```bash
   node scripts/prepare-isc-sp-config.mjs \
     --input config/isc/exports/aws-bedrock.raw.json \
     --output config/isc/golden/aws-bedrock.sp-config.json \
     --base-url https://main.d12mzah9vzl24s.amplifyapp.com
   ```

   Repeat for GCP and Azure.

3. **Review** `config/isc/golden/*.json` — no PATs or secrets.

4. **Commit** the `golden/` files. After deploy, Setup download buttons go live.

### Export reference (if you need to re-export)

See [export-payloads/](./export-payloads/) or VS Code **Export sp-config** on each source.

---

## Folder layout

| Path | Purpose |
|------|---------|
| `exports/` | Your raw downloads (gitignored) |
| `golden/` | Templated JSON committed to the repo |
| `golden/privilege-classification.*.json` | Phase 2 — privilege criteria (see PRIVILEGE_CLASSIFICATION.md) |
| `manifest.json` | Platform list for the Setup API |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Setup shows “not published yet” | Maintainer has not committed `golden/*.sp-config.json` |
| Test connection fails | Wrong base URL — check Amplify `AGENTFORGE_BASE_URL` or request Host header |
| Source calls `localhost` after deploy | The base URL is substituted at download/import time, so sources imported from a laptop keep that URL. Verify the source in Setup and use **Repoint source at this deployment** |
| Import overwrites source | ISC matches by **source name**; rename in golden JSON or target tenant |
| Dataset missing after import | Expected — packages no longer ship the dataset/resource. Run Demo full sync, or create them under Dataset Management |
| Import fails: *Cannot create resource as schema* | Stale package with a `std:agent` schema. Re-download; agent resources are created via the resources API, not SP-Config |
| Orchestrator skips entitlement steps | Ensure **Group Aggregation** HTTP op exists (CONNECTOR_SETUP Part D2.5) |
