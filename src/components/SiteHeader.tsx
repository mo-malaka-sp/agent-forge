import Link from "next/link";

import { SiteNav } from "@/components/SiteNav";

export function SiteHeader() {
  return (
    <header className="brand-header">
      <div className="brand-header__inner">
        <Link href="/" className="brand-lockup" aria-label="AgentForge home">
          <svg
            className="brand-mark"
            viewBox="0 0 72 72"
            role="img"
            aria-label="SailPoint"
          >
            <path fill="#0032a1" d="M36 7 44.2 45H13.5L36 7Z" />
            <path fill="#d60db5" d="M36 7 60 45H44.2L36 7Z" />
            <path fill="#0071cd" d="M13.5 45h30.7l2.8 14L13.5 45Z" />
            <path fill="#e17fd2" d="M44.2 45H60L47 59l-2.8-14Z" />
          </svg>
          <div>
            <h1 className="brand-lockup__title">AgentForge</h1>
            <p className="brand-lockup__subtitle">
              Discover · govern · test · demonstrate
            </p>
          </div>
        </Link>
        <SiteNav />
        <span className="brand-header__badge">
          <span className="brand-header__badge-dot" aria-hidden="true" />
          Agentic Fabric
        </span>
      </div>
    </header>
  );
}
