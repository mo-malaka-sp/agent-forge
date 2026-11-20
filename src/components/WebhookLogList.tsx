export type WebhookLogEntryView = {
  at: string;
  message: string;
};

export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function WebhookLogList({ entries, empty }: { entries: WebhookLogEntryView[]; empty: string }) {
  const newestFirst = [...entries].reverse();
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium">Webhook log</h3>
      {newestFirst.length === 0 ? (
        <p className="text-xs text-zinc-500">{empty}</p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-auto rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
          {newestFirst.map((entry) => (
            <li key={`${entry.at}-${entry.message}`} className="flex gap-3">
              <time dateTime={entry.at} className="shrink-0 font-mono text-zinc-500">
                {formatLogTime(entry.at)}
              </time>
              <span>{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
