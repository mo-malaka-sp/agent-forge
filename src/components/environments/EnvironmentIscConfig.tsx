export function EnvironmentIscConfig({ sourceName }: { sourceName: string }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <h2 className="text-base font-semibold">ISC configuration</h2>
      <p className="mt-2 text-zinc-600">
        Source <strong>{sourceName}</strong> aggregates <span className="font-mono">aws:iam</span> and{" "}
        <span className="font-mono">aws:bedrockagentcore</span>.
      </p>
    </section>
  );
}
