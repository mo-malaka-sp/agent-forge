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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-10">
      <section className="forge-hero space-y-3">
        <span className="forge-eyebrow">Agentic identity governance</span>
        <div className="flex">
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
        <h1 className="relative z-10 text-3xl font-semibold tracking-tight">
          Build governed agent demonstrations
        </h1>
        <p className="relative z-10 max-w-2xl text-sm text-zinc-600">
          Create, connect, govern, and test synthetic AI agents with SailPoint
          Identity Security Cloud. Choose a workflow to begin.
        </p>
      </section>

      <HomeContinueDemo />

      <div className="grid gap-4">
        {PATHS.map((path) => (
          <Link
            key={path.href}
            href={path.href}
            className={`forge-card group p-5 ${
              path.primary ? "forge-card--primary" : ""
            }`}
          >
            <h2 className="text-base font-semibold">
              {path.title}
            </h2>
            <p className="mt-1 text-sm text-zinc-600">
              {path.description}
            </p>
            <p className="forge-link mt-3 text-sm font-semibold">
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
