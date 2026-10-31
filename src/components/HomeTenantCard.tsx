"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { loadIscSessionCache } from "@/lib/isc/session-cache";
import { resolveVisibleTenant } from "@/lib/isc/visible-tenant";

export function HomeTenantCard({
  serverConnected,
  serverTenant,
}: {
  serverConnected: boolean;
  serverTenant: string | null;
}) {
  const [connected, setConnected] = useState(serverConnected);
  const [tenant, setTenant] = useState(serverConnected ? serverTenant : null);

  useEffect(() => {
    const sessionTenant = loadIscSessionCache()?.tenant ?? null;
    const fromSession = resolveVisibleTenant({
      serverConnected,
      serverTenant,
      sessionTenant,
      apiConfigured: null,
      apiTenant: null,
    });
    setConnected(fromSession.connected);
    setTenant(fromSession.tenant);

    let cancelled = false;
    void fetch("/api/isc/credentials")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { configured?: boolean; tenant?: string | null } | null) => {
        if (cancelled || !body) {
          return;
        }
        const next = resolveVisibleTenant({
          serverConnected,
          serverTenant,
          sessionTenant,
          apiConfigured: Boolean(body.configured),
          apiTenant: body.tenant ?? null,
        });
        setConnected(next.connected);
        setTenant(next.tenant);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [serverConnected, serverTenant]);

  return (
    <Link href="/demo?phase=setup" className="home-tenant" aria-labelledby="tenant-heading">
      <div className="home-tenant__intro">
        <div>
          <span className="forge-eyebrow">Shared tenant</span>
          <h2 id="tenant-heading">{connected && tenant ? tenant : "Connect one ISC tenant"}</h2>
          <p>Discover, Govern, and Protect all use this Identity Security Cloud connection.</p>
        </div>
        <span
          className={`home-status home-status--on-light ${
            connected ? "home-status--connected" : "home-status--attention"
          }`}
        >
          <span className="home-status__dot" aria-hidden="true" />
          {connected ? "Connected" : "Not connected"}
        </span>
      </div>
    </Link>
  );
}
