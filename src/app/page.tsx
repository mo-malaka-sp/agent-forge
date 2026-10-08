import Link from "next/link";

import { HomeContinueDemo } from "@/components/HomeContinueDemo";
import { getIscPublicStatus } from "@/lib/isc/config";

const PATHS = [
  {
    href: "/demo",
    title: "ISC demo workspace",
    description:
      "Connect to your tenant, bootstrap sources if needed, then run full sync or govern + enforce.",
    cta: "Open workspace",
    primary: true,
  },
  {
    href: "/saf-poc",
    title: "SAF event bus and Datadog",
    description:
      "Change an agent’s risk, prove the CAEP email workflow, and forward the same event to Datadog.",
    cta: "Open SAF POC",
    primary: false,
  },
  {
    href: "/agents",
    title: "Manage agents",
    description:
      "Create, bulk seed, and browse synthetic AI agents with outbound and inbound access.",
    cta: "Browse agents",
    primary: false,
  },
] as const;

export default function HomePage() {
  const isc = getIscPublicStatus();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <section className="space-y-3 text-center">
        <div className="flex justify-center">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              isc.configured
                ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isc.configured ? "bg-emerald-500" : "bg-amber-500"
              }`}
            />
            {isc.configured
              ? `ISC connected · ${isc.tenant}`
              : "ISC not configured"}
          </span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          AgentForge
        </h1>
        <p className="mx-auto max-w-lg text-sm text-zinc-600 dark:text-zinc-400">
          Mock AI agents for SailPoint Identity Security Cloud demos. Pick where
          to start.
        </p>
      </section>

      <HomeContinueDemo />

      <div className="grid gap-4">
        {PATHS.map((path) => (
          <Link
            key={path.href}
            href={path.href}
            className={`group rounded-lg border p-5 transition hover:shadow-sm ${
              path.primary
                ? "border-indigo-200 bg-indigo-50/50 hover:border-indigo-300 dark:border-indigo-900 dark:bg-indigo-950/30 dark:hover:border-indigo-800"
                : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-700"
            }`}
          >
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {path.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {path.description}
            </p>
            <p
              className={`mt-3 text-sm font-medium ${
                path.primary
                  ? "text-indigo-700 group-hover:text-indigo-800 dark:text-indigo-300 dark:group-hover:text-indigo-200"
                  : "text-zinc-700 group-hover:text-zinc-900 dark:text-zinc-300 dark:group-hover:text-zinc-100"
              }`}
            >
              {path.cta} →
            </p>
          </Link>
        ))}
      </div>

      <p className="text-center text-xs text-zinc-500">
        First time on a new tenant?{" "}
        <Link
          href="/demo?phase=bootstrap"
          className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          Open bootstrap steps
        </Link>
        {" · "}
        <Link
          href="/setup/guide"
          className="font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          Maintainer connector reference
        </Link>
      </p>
    </div>
  );
}
