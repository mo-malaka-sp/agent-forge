interface DemoPhaseHeaderProps {
  phase?: number;
  title: string;
  description: string;
  optional?: boolean;
}

export function DemoPhaseHeader({
  phase,
  title,
  description,
  optional,
}: DemoPhaseHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      {typeof phase === "number" ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
          {phase}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          {optional ? (
            <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
              First-time
            </span>
          ) : null}
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
      </div>
    </div>
  );
}
