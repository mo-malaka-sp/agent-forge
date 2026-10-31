import { AskTenantPanel } from "@/components/AskTenantPanel";

export const dynamic = "force-dynamic";
import { getIscPublicStatus } from "@/lib/isc/config";

export default function AskTenantPage() {
  const isc = getIscPublicStatus();
  const tenant = isc.credentialsConfigured ? isc.tenant : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Ask</p>
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
      <section className="max-w-3xl space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
        <h2 className="text-base font-medium text-zinc-900 dark:text-zinc-100">Ask from Claude</h2>
        <p>
          Claude can call the same reads at <code>/api/ask-tenant/mcp</code> without opening this
          page. The tools are <code>search_identities</code>, <code>search_access</code>,{" "}
          <code>search_audit_events</code>, <code>list_saf_events</code>,{" "}
          <code>list_agents</code>, and <code>describe_agent</code>. They use the tenant this app
          is already connected to.
        </p>
        <p>
          Send the worker token in the <code>x-agentforge-worker</code> header, or as{" "}
          <code>Authorization: Bearer</code>. A signed-in session works too.
        </p>
      </section>
    </div>
  );
}
