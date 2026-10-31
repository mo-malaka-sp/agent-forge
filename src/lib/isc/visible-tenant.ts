export interface VisibleTenantInput {
  serverConnected: boolean;
  serverTenant: string | null;
  sessionTenant: string | null;
  apiConfigured: boolean | null;
  apiTenant: string | null;
}

export interface VisibleTenant {
  connected: boolean;
  tenant: string | null;
}

/** The browser save wins. The credentials API is next. The server render is the fallback. */
export function resolveVisibleTenant(input: VisibleTenantInput): VisibleTenant {
  const sessionTenant = input.sessionTenant?.trim() || null;
  if (sessionTenant) {
    return { connected: true, tenant: sessionTenant };
  }

  if (input.apiConfigured && input.apiTenant?.trim()) {
    return { connected: true, tenant: input.apiTenant.trim() };
  }

  if (input.serverConnected && input.serverTenant?.trim()) {
    return { connected: true, tenant: input.serverTenant.trim() };
  }

  return { connected: false, tenant: null };
}
