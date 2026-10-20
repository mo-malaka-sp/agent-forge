import Link from "next/link";

const DEMOS = [
  { href: "/demo?phase=run", label: "Run governance demo" },
  { href: "/saf-poc?section=caep", label: "Send CAEP event" },
  { href: "/saf-poc?section=endpoint", label: "Open endpoint risk" },
  { href: "/saf-poc?section=datadog", label: "Generate Datadog signals" },
];

export function EnvironmentDemoLaunch() {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-base font-semibold">Demos</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {DEMOS.map((demo) => (
          <Link
            key={demo.href}
            href={demo.href}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium"
          >
            {demo.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
