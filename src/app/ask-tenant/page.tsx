import { AskTenantPanel } from "@/components/AskTenantPanel";
import { getIscPublicStatus } from "@/lib/isc/config";

export const dynamic = "force-dynamic";

export default function AskTenantPage() {
  const isc = getIscPublicStatus();
  const tenant = isc.credentialsConfigured ? isc.tenant : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Discover</p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Ask this tenant
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Answers come from Identity Security Cloud search and the SAF events already stored in
          AgentForge. Each read returns at most 25 rows. Questions that create, change, or delete
          data are refused.
        </p>
      </section>
      <AskTenantPanel tenant={tenant} />
      <section className="max-w-3xl space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          Ask from an MCP client
        </h2>
        <p>Download the config and add the ask-this-tenant server to your client.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Cursor: <code>.cursor/mcp.json</code>
          </li>
          <li>
            Claude Code: <code>.mcp.json</code>
          </li>
          <li>Any other client that accepts a remote MCP URL and an Authorization header.</li>
        </ul>
        <a
          href="/api/ask-tenant/mcp/config"
          className="inline-flex rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
        >
          Download MCP config
        </a>
        <p>
          The file uses the same username and password you use to sign in here. If a config file
          already exists, copy the ask-this-tenant entry into it. Do not commit the file.
        </p>
      </section>
    </div>
  );
}
