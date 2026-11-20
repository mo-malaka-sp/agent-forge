import { PocTrackerPanel } from "@/components/PocTrackerPanel";

export default function PocTrackerPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <section className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Test tool · SAF POC Tracker
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          SAF POC Tracker
        </h1>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Post a Slack thread reply when a POC request moves into Active Provisioning, Implemented / Live,
          Completed, or Rejected. This is a different Asana project from SAF TestDrive Accounts.
        </p>
      </section>
      <PocTrackerPanel />
    </div>
  );
}
