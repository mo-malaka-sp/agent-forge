import Link from "next/link";

import { EnvironmentWizard } from "@/components/environments/EnvironmentWizard";

export default function EnvironmentsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">Connect Agent Environments</h1>
        <p className="max-w-3xl text-sm text-zinc-600">
          Connect AWS, configure the ISC source, and discover real AgentCore agents. Synthetic
          AgentForge agents stay available separately.
        </p>
        <Link href="/agents" className="text-sm font-medium text-blue-700">
          Open synthetic agents
        </Link>
      </section>
      <EnvironmentWizard />
    </main>
  );
}
