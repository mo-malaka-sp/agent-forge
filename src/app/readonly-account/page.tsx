import { ReadonlyAccountPanel } from "@/components/ReadonlyAccountPanel";

export default function ReadonlyAccountPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Test tool · SAF Test Drive
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Read-only test accounts
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Create a sign-in user on the ISC Admins source. The ReadOnly-Admins role grants
          SAF Admin to accounts whose groups contain ReadOnly-Admins.
        </p>
      </section>
      <ReadonlyAccountPanel />
    </div>
  );
}
