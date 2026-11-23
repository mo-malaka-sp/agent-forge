"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { loadTenantState } from "@/components/TenantPicker";
import type { IscProfilePublic } from "@/lib/isc/profile-types";

/** Shows the default saved tenant. Each feature can point at its own tenant on the Tenants page. */
export function HomeTenantCard() {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState<IscProfilePublic | null>(null);
  const [assigned, setAssigned] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadTenantState()
      .then((state) => {
        if (cancelled) return;
        const defaultId = state.bindings.default ?? null;
        setProfile(state.profiles.find((item) => item.id === defaultId) ?? null);
        setAssigned(
          Object.entries(state.bindings).filter(([feature, id]) => feature !== "default" && Boolean(id))
            .length,
        );
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = Boolean(profile);

  return (
    <Link href="/tenants" className="home-tenant" aria-labelledby="tenant-heading">
      <div className="home-tenant__intro">
        <div>
          <span className="forge-eyebrow">Saved tenants</span>
          <h2 id="tenant-heading">
            {connected && profile ? profile.tenantUrl : "Save a SailPoint tenant"}
          </h2>
          <p>
            {connected && profile
              ? `Default: ${profile.name}. ${assigned} feature${assigned === 1 ? "" : "s"} use their own tenant.`
              : "Add a tenant once, then pick which tenant each feature uses."}
          </p>
        </div>
        <span
          className={`home-status home-status--on-light ${
            connected ? "home-status--connected" : "home-status--attention"
          }`}
        >
          <span className="home-status__dot" aria-hidden="true" />
          {!loaded ? "Loading" : connected ? "Default set" : "Not set"}
        </span>
      </div>
    </Link>
  );
}
