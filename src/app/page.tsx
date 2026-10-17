import Link from "next/link";

import { HomeContinueDemo } from "@/components/HomeContinueDemo";
import { getIscPublicStatus } from "@/lib/isc/config";

const PATHS = [
  {
    href: "/agents",
    step: "01",
    eyebrow: "Discover",
    title: "Build Demo Agents",
    description:
      "Create, bulk seed, and inspect synthetic agents with realistic inbound and outbound access.",
    cta: "Manage agents",
    icon: "build",
    accent: "aqua",
  },
  {
    href: "/demo?phase=run",
    step: "02",
    eyebrow: "Govern",
    title: "Govern AI Agents",
    description:
      "Aggregate agent access and demonstrate governance and enforcement end to end.",
    cta: "Run governance demo",
    icon: "govern",
    accent: "cobalt",
  },
  {
    href: "/saf-poc#risk-response",
    step: "03",
    eyebrow: "Protect",
    title: "Automate Risk Response",
    description:
      "Send CAEP risk changes into SailPoint and prove the workflow response with an email.",
    cta: "Test risk workflow",
    icon: "automate",
    accent: "pink",
  },
  {
    href: "/saf-poc#security-signals",
    step: "04",
    eyebrow: "Protect",
    title: "Investigate Security Signals",
    description:
      "Forward agent risk to Datadog, open security signals, and link back to the agent in SailPoint.",
    cta: "Open signal lab",
    icon: "detect",
    accent: "pink",
  },
] as const;

export default function HomePage() {
  const isc = getIscPublicStatus();

  return (
    <main className="home-page mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
      <section className="home-hero">
        <div className="home-hero__content">
          <span className="forge-eyebrow">SailPoint Agentic Fabric</span>
          <h1>Agent identity demos, ready to run</h1>
          <p>
            Build realistic AI agents, govern their access in Identity Security
            Cloud, and prove how risk becomes action.
          </p>
        </div>

        <div className="home-hero__journey" aria-label="AgentForge workflow">
          <p className="home-hero__journey-label">From agent to evidence</p>
          <ol>
            <li>
              <span>01</span>
              <strong>Discover</strong>
            </li>
            <li>
              <span>02</span>
              <strong>Govern</strong>
            </li>
            <li>
              <span>03</span>
              <strong>Protect</strong>
            </li>
          </ol>
        </div>
      </section>

      <HomeContinueDemo />

      <Link href="/demo?phase=setup" className="home-tenant" aria-labelledby="tenant-heading">
        <div className="home-tenant__intro">
          <div>
            <span className="forge-eyebrow">Shared tenant</span>
            <h2 id="tenant-heading">
              {isc.credentialsConfigured && isc.tenant
                ? isc.tenant
                : "Connect one ISC tenant"}
            </h2>
            <p>
              Discover, Govern, and Protect all use this Identity Security Cloud
              connection.
            </p>
          </div>
          <span
            className={`home-status home-status--on-light ${
              isc.credentialsConfigured ? "home-status--connected" : "home-status--attention"
            }`}
          >
            <span className="home-status__dot" aria-hidden="true" />
            {isc.credentialsConfigured ? "Connected" : "Not connected"}
          </span>
        </div>
      </Link>

      <section className="home-workspaces" aria-labelledby="workspace-heading">
        <div className="home-section-heading">
          <div>
            <span className="forge-eyebrow">Workspaces</span>
            <h2 id="workspace-heading">Choose where to start</h2>
          </div>
          <p>Each workspace can stand alone or become part of one complete demo.</p>
        </div>

        <div className="home-card-grid">
          {PATHS.map((path) => (
            <Link
              key={path.href}
              href={path.href}
              className={`home-feature-card home-feature-card--${path.accent}`}
              aria-label={`${path.title}: ${path.cta}`}
            >
              <div className="home-feature-card__top">
                <span className="home-feature-card__icon" aria-hidden="true">
                  <FeatureIcon name={path.icon} />
                </span>
                <span className="home-feature-card__step">{path.step}</span>
              </div>
              <p className="home-feature-card__eyebrow">{path.eyebrow}</p>
              <h3>{path.title}</h3>
              <p className="home-feature-card__description">{path.description}</p>
              <span className="home-feature-card__cta">
                {path.cta}
                <span aria-hidden="true">→</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

    </main>
  );
}

function FeatureIcon({ name }: { name: (typeof PATHS)[number]["icon"] }) {
  if (name === "build") {
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 3 20 7.5 12 12 4 7.5 12 3Z" />
        <path d="m4 12 8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" />
      </svg>
    );
  }
  if (name === "govern") {
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 3 19 6v5c0 4.6-2.8 8.3-7 10-4.2-1.7-7-5.4-7-10V6l7-3Z" />
        <path d="m9 12 2 2 4-5" />
      </svg>
    );
  }
  if (name === "automate") {
    return (
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M12 3 19 6v5c0 4.6-2.8 8.3-7 10-4.2-1.7-7-5.4-7-10V6l7-3Z" />
        <path d="M9 12h6M13 9l3 3-3 3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 3a8 8 0 1 0 8 8" />
      <path d="M12 7v5l3 2M17 3h4v4M21 3l-5 5" />
    </svg>
  );
}
