"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SiteHeader } from "@/components/SiteHeader";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") {
    return children;
  }

  return (
    <div className="brand-shell flex min-h-screen flex-col">
      <SiteHeader />
      {children}
    </div>
  );
}
