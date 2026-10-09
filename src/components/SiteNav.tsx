"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_LINKS = [
  { href: "/demo", label: "ISC Demo" },
  { href: "/saf-poc", label: "SAF POC" },
  { href: "/agents", label: "Agents", matchPrefix: true },
] as const;

function isActive(pathname: string, href: string, matchPrefix?: boolean) {
  if (matchPrefix) {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href;
}

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="brand-nav" aria-label="AgentForge">
      {NAV_LINKS.map((link) => {
        const active = isActive(pathname, link.href, "matchPrefix" in link && link.matchPrefix);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
      <Link
        href="/agents/new"
        className="brand-nav__primary"
      >
        New Agent
      </Link>
    </nav>
  );
}
