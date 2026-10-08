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
    <nav className="flex items-center gap-2">
      {NAV_LINKS.map((link) => {
        const active = isActive(pathname, link.href, "matchPrefix" in link && link.matchPrefix);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-2 text-sm font-medium transition ${
              active
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
      <Link
        href="/agents/new"
        className="ml-1 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
      >
        New Agent
      </Link>
    </nav>
  );
}
