export interface ParsedIscTenantUrl {
  tenant: string;
  domain: string;
  tenantUrl: string;
}

const EXAMPLE_TENANT_URL = "https://acme.identitynow-demo.com/";

/**
 * SailPoint domains a saved tenant may use. Client secrets are only sent to
 * `https://<tenant>.api.<domain>` for a domain on this list, so a user cannot point a saved
 * secret at another host.
 */
export const ALLOWED_ISC_DOMAINS = ["identitynow.com", "identitynow-demo.com"] as const;

const TENANT_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isAllowedIscDomain(domain: string): boolean {
  return (ALLOWED_ISC_DOMAINS as readonly string[]).includes(domain.trim().toLowerCase());
}

/** Returns a problem message, or null when the tenant and domain may be used. */
export function iscHostProblem(tenant: string, domain: string): string | null {
  if (!TENANT_LABEL.test(tenant.trim().toLowerCase())) {
    return "The tenant name may only contain letters, numbers and hyphens.";
  }
  if (!isAllowedIscDomain(domain)) {
    return `The tenant domain must be ${ALLOWED_ISC_DOMAINS.join(" or ")}.`;
  }
  return null;
}

export function formatIscTenantUrl(tenant: string, domain: string): string {
  const slug = tenant.trim();
  const host = domain.trim();
  if (!slug || !host) {
    return "";
  }
  return `https://${slug}.${host}/`;
}

export function parseIscTenantUrl(input: string): ParsedIscTenantUrl | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  let hostname: string;
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    hostname = new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return null;
  }

  // Accept API hostnames too (tenant.api.domain → tenant.domain).
  const normalizedHost = hostname.replace(/^([^.]+)\.api\.(.+)$/, "$1.$2");
  const labels = normalizedHost.split(".").filter(Boolean);

  if (labels.length < 3) {
    return null;
  }

  const tenant = labels[0];
  const domain = labels.slice(1).join(".");

  if (!tenant || !domain) {
    return null;
  }

  return {
    tenant,
    domain,
    tenantUrl: formatIscTenantUrl(tenant, domain),
  };
}

export function parseIscTenantUrlOrThrow(input: string): ParsedIscTenantUrl {
  const parsed = parseIscTenantUrl(input);
  if (!parsed) {
    throw new Error(
      `Enter a valid tenant URL (e.g. ${EXAMPLE_TENANT_URL})`,
    );
  }
  return parsed;
}

export const ISC_TENANT_URL_PLACEHOLDER = EXAMPLE_TENANT_URL;
